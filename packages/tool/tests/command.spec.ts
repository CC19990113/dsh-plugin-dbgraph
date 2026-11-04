import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionSummary, IndexReport } from 'dsh-plugin-dbgraph-service'
import {
  COMMAND_DEFINITION_ID,
  COMMAND_DESCRIPTION,
  COMMAND_INPUT_HINT,
  COMMAND_NAME,
  COMMAND_USAGE,
  registerCommands,
} from '../src/command.ts'
import type { CommandDefinition, CommandInvocation, CommandResult } from '../src/command.ts'

const CONNECTION: ConnectionSummary = {
  id: 'prod',
  engine: 'mysql',
  label: '生产库',
  host: 'mysql.internal',
  database: 'shop',
  credentialConfigured: true,
  index: { l1IndexedAt: 1, l2IndexedAt: 2, objects: 312, columns: 6840, stale: false },
}

const REPORT: IndexReport = {
  connection: 'prod',
  level: 'full',
  objects: 312,
  columns: 6840,
  edges: 44,
  terms: 900,
  writer: 'js',
  elapsedMs: 1234,
  warnings: [],
}

/** A fake command registry that records the definitions it is given. */
function fakeCommands(): { definitions: CommandDefinition[]; register(definition: CommandDefinition): () => void } {
  const definitions: CommandDefinition[] = []
  return {
    definitions,
    register(definition: CommandDefinition) {
      definitions.push(definition)
      return () => {
        const index = definitions.indexOf(definition)
        if (index >= 0) definitions.splice(index, 1)
      }
    },
  }
}

/** A fake host context: only the two members `registerCommands` touches. */
function stubHost(
  services: Record<string, unknown>,
  options: { injectThrows?: boolean } = {},
): { ctx: Context; disposers: (() => void)[]; injections: string[][] } {
  const disposers: (() => void)[] = []
  const injections: string[][] = []
  const child = {
    effect(execute: () => () => void) {
      const disposer = execute()
      disposers.push(disposer)
      return disposer
    },
    ...services,
  }
  const ctx = {
    inject(deps: string[], callback: (value: unknown) => void) {
      injections.push(deps)
      if (options.injectThrows === true) throw new Error('service injection failed')
      callback(child)
    },
    ...services,
  } as unknown as Context
  return { ctx, disposers, injections }
}

/** Register the command over a fake host and expose the recorded definition. */
function commandSubject(dbgraph: Record<string, unknown>): {
  host: ReturnType<typeof stubHost>
  commands: ReturnType<typeof fakeCommands>
  definition(): CommandDefinition
} {
  const commands = fakeCommands()
  const host = stubHost({ commands, dbgraph })
  registerCommands(host.ctx)
  return {
    host,
    commands,
    definition() {
      const found = commands.definitions[0]
      if (found === undefined) throw new Error('the command was not registered')
      return found
    },
  }
}

/** Call one command handler the way the registry does. */
async function runCommand(definition: CommandDefinition, rawInput: string, signal?: AbortSignal): Promise<CommandResult> {
  const invocation: CommandInvocation = { rawInput, ...signal === undefined ? {} : { signal } }
  return definition.handler(invocation)
}

describe('command registration', () => {
  it('registers one command with its discovery copy and drops it on disposal', () => {
    const subject = commandSubject({})
    expect(subject.host.injections).toEqual([['commands']])
    const definition = subject.definition()
    expect(definition.definitionId).toBe(COMMAND_DEFINITION_ID)
    expect(definition.name).toBe(COMMAND_NAME)
    expect(definition.description).toBe(COMMAND_DESCRIPTION)
    expect(definition.input).toEqual({ hint: COMMAND_INPUT_HINT })
    expect(typeof definition.handler).toBe('function')
    subject.host.disposers.forEach(dispose => dispose())
    expect(subject.commands.definitions).toEqual([])
  })

  it('stays out of the way when the service cannot be injected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const host = stubHost({}, { injectThrows: true })
      expect(() => registerCommands(host.ctx)).not.toThrow()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the /dbgraph command', () => {
  it('answers a bare invocation with the status view', async () => {
    const subject = commandSubject({ listConnections: () => Promise.resolve([CONNECTION]) })
    const result = await runCommand(subject.definition(), '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('索引根：')
    expect(result.text).toContain('prod "生产库" (mysql) mysql.internal/shop — 312 表 / 6840 列')
  })

  it('reports an index state that has never been built, and a missing credential', async () => {
    const subject = commandSubject({
      listConnections: () => Promise.resolve([{
        id: 'local', engine: 'sqlite', credentialConfigured: false,
        index: { objects: 0, columns: 0, stale: true },
      }]),
    })
    const result = await runCommand(subject.definition(), 'status')
    expect(result.text).toContain('local (sqlite) — not indexed（凭据未配置）')
  })

  it('names the configuration file when nothing is configured', async () => {
    const subject = commandSubject({ listConnections: () => Promise.resolve([]) })
    const result = await runCommand(subject.definition(), 'status')
    expect(result.text).toContain('还没有配置连接')
    expect(result.text).toContain('connections.json')
  })

  it('lists the connections the model may pass as --connection', async () => {
    const subject = commandSubject({ listConnections: () => Promise.resolve([CONNECTION]) })
    const result = await runCommand(subject.definition(), 'connections')
    // `connections` names the ids the model passes, so it omits the display label `status` shows.
    expect(result.text).toBe('prod (mysql) mysql.internal/shop')
  })

  it('answers the connections view with an empty list', async () => {
    const subject = commandSubject({ listConnections: () => Promise.resolve([]) })
    expect(await runCommand(subject.definition(), 'connections')).toEqual({ kind: 'success', text: '还没有配置连接。' })
  })

  it('indexes one connection with the flags it was given', async () => {
    const seen: unknown[] = []
    const subject = commandSubject({
      index: (request: unknown, signal?: AbortSignal) => {
        seen.push([request, signal])
        return Promise.resolve(REPORT)
      },
    })
    const controller = new AbortController()
    const result = await runCommand(subject.definition(), 'index --connection prod --mode l1 --writer rust', controller.signal)
    expect(seen).toEqual([[{ connection: 'prod', mode: 'l1', writer: 'rust' }, controller.signal]])
    expect(result).toEqual({
      kind: 'success',
      text: '已索引 prod（full）：312 对象 / 6840 列 / 44 关系，900 检索词，writer js，1234 ms。',
    })
  })

  it('indexes every connection when no flag narrows it', async () => {
    const seen: unknown[] = []
    const subject = commandSubject({
      index: (request: unknown) => {
        seen.push(request)
        return Promise.resolve(REPORT)
      },
    })
    await runCommand(subject.definition(), 'index')
    expect(seen).toEqual([{ mode: 'full' }])
  })

  it('appends the warnings a run reported', async () => {
    const subject = commandSubject({
      index: () => Promise.resolve({ ...REPORT, warnings: ['enum sampling skipped'] }),
    })
    expect((await runCommand(subject.definition(), 'index')).text).toContain('警告：enum sampling skipped')
  })

  it.each<[string, string]>([
    ['an unknown subcommand', 'tables'],
    ['an unknown flag', 'index --verbose'],
    ['a flag with no value', 'index --connection'],
    ['a mode outside the vocabulary', 'index --mode deep'],
    ['a writer outside the vocabulary', 'index --writer native'],
  ])('rejects %s with the usage line', async (_label, input) => {
    const subject = commandSubject({})
    const result = await runCommand(subject.definition(), input)
    expect(result.kind).toBe('error')
    expect(result.text).toContain(COMMAND_USAGE)
  })

  it('settles a seam failure as an error result instead of throwing', async () => {
    const subject = commandSubject({ listConnections: () => Promise.reject(new Error('no store registered')) })
    const result = await runCommand(subject.definition(), 'status')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('no store registered')
  })
})
