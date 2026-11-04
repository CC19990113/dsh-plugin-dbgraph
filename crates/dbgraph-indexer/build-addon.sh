#!/usr/bin/env bash
# Build the napi addon and name the artifact the way a Node loader expects.
#
# This is the offline path: it needs `cargo` and nothing else. `napi build` (see the `build:napi`
# script) produces the same file plus generated `index.js`/`index.d.ts`, but it needs
# `@napi-rs/cli` from the npm registry, which is why it is not the default here.
#
# Two host facts this script exists to handle, both verified on this machine:
#
# 1. The default rust toolchain is `stable-x86_64-apple-darwin` while Node is arm64. A default
#    build therefore produces an x64 `.node` that arm64 Node refuses to dlopen
#    ("incompatible architecture").
# 2. Passing `--target` keeps every triple's artifacts in `target/<triple>/release/`, so
#    alternating between two native toolchains cannot thrash one shared `target/release/`.
set -euo pipefail
cd "$(dirname "$0")"

platform="$(node -p 'process.platform')"
arch="$(node -p 'process.arch')"

case "$platform/$arch" in
  darwin/arm64) triple="aarch64-apple-darwin" ;;
  darwin/x64) triple="x86_64-apple-darwin" ;;
  linux/arm64) triple="aarch64-unknown-linux-gnu" ;;
  linux/x64) triple="x86_64-unknown-linux-gnu" ;;
  win32/x64) triple="x86_64-pc-windows-msvc" ;;
  *)
    echo "build-addon: unsupported platform $platform/$arch" >&2
    exit 1
    ;;
esac

# Prefer a rust toolchain whose host is the target triple: rustup then needs no extra target
# installed, and a cross-link (which would need a linker that is not here) is never attempted.
if [[ -z "${RUSTUP_TOOLCHAIN:-}" ]] && rustup toolchain list 2>/dev/null | grep -qx "stable-${triple}"; then
  export RUSTUP_TOOLCHAIN="stable-${triple}"
  echo "build-addon: using rust toolchain $RUSTUP_TOOLCHAIN"
fi

cargo build --release --target "$triple"

case "$platform" in
  darwin) library="target/$triple/release/libdbgraph_indexer.dylib" ;;
  linux) library="target/$triple/release/libdbgraph_indexer.so" ;;
  win32) library="target/$triple/release/dbgraph_indexer.dll" ;;
esac

if [[ ! -f "$library" ]]; then
  echo "build-addon: cargo did not produce $library" >&2
  exit 1
fi

mkdir -p artifacts
artifact="artifacts/dbgraph-indexer.${platform}-${arch}.node"
cp "$library" "$artifact"
echo "build-addon: $artifact ($(wc -c < "$artifact" | tr -d ' ') bytes)"
