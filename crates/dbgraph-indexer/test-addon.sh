#!/usr/bin/env bash
# Run the crate's tests against the toolchain that matches this host's Node.
#
# Same two facts as `build-addon.sh`: the default rust toolchain here is x86_64 while Node is arm64,
# and passing `--target` keeps each triple's artifacts in its own directory. `--release` reuses the
# bundled-SQLite build instead of compiling a second, debug one.
set -euo pipefail
cd "$(dirname "$0")"

platform="$(node -p 'process.platform')"
arch="$(node -p 'process.arch')"

case "$platform/$arch" in
  darwin/arm64) triple="aarch64-apple-darwin" ;;
  darwin/x64) triple="x86_64-apple-darwin" ;;
  linux/arm64) triple="aarch64-unknown-linux-gnu" ;;
  linux/x64) triple="x86_64-unknown-linux-gnu" ;;
  *)
    echo "test-addon: unsupported platform $platform/$arch" >&2
    exit 1
    ;;
esac

if [[ -z "${RUSTUP_TOOLCHAIN:-}" ]] && rustup toolchain list 2>/dev/null | grep -qx "stable-${triple}"; then
  export RUSTUP_TOOLCHAIN="stable-${triple}"
fi

exec cargo test --release --target "$triple" "$@"
