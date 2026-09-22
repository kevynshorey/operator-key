#!/usr/bin/env bash
#
# Build release packages without embedding the builder's identity.
#
# Rust writes source paths into panic messages and debug info. Dependency paths run
# through the local Cargo registry, so a plain `cargo build --release` ships strings like
# `/home/<username>/.cargo/registry/.../glib-0.18.5/src/main_context.rs`. Running
# `strings` over a default-built `.deb` payload found 209 of them. Anyone who downloads a
# release can read the username of the machine that produced it.
#
# `--remap-path-prefix` fixes this, but it must target the directories that actually
# contain the username. Remapping only `/home/` leaves `/redacted/<username>/...` behind,
# which discloses exactly the same thing.
#
# This lives in a script rather than `.cargo/config.toml` because Cargo does not expand
# environment variables inside that file, so a committed config cannot name the operator's
# own `$HOME` or `$CARGO_HOME` portably.
#
# `trim-paths` would be the purpose-built answer, but it is still unstable in Cargo 1.98
# and aborts the build on stable. Revisit when it stabilises.
set -euo pipefail

cargo_home="${CARGO_HOME:-$HOME/.cargo}"
rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Longest paths first: Cargo applies these in order and the first match wins.
remap=(
  "--remap-path-prefix=${cargo_home}=/cargo"
  "--remap-path-prefix=${rustup_home}=/rustup"
  "--remap-path-prefix=${repo_root}=/operator-key"
  # Backstop for anything else rooted in a home directory.
  "--remap-path-prefix=${HOME}=/build"
)

export RUSTFLAGS="${RUSTFLAGS:-} ${remap[*]}"

echo "Building with builder identity stripped from embedded paths."
npx tauri build --bundles deb,rpm "$@"

binary="${repo_root}/src-tauri/target/release/operator-key"
if [ ! -f "$binary" ]; then
  echo "Expected binary not found at ${binary}" >&2
  exit 1
fi

echo
echo "Verifying the built binary discloses no builder identity..."

fail=0
if strings -n 6 "$binary" | grep -qE '/home/[a-z0-9_-]+/|/Users/[a-z0-9_-]+/'; then
  echo "FAIL: a real home directory path survives in the binary:" >&2
  strings -n 6 "$binary" | grep -oE '/home/[a-z0-9_-]+/|/Users/[a-z0-9_-]+/' | sort -u >&2
  fail=1
fi

user="$(id -un)"
if strings -n 4 "$binary" | grep -qF "/${user}/"; then
  echo "FAIL: the binary names the building user (${user})" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "PASS: no home paths and no builder username in the binary."
echo
echo "Packages:"
find "${repo_root}/src-tauri/target/release/bundle" -type f \( -name '*.deb' -o -name '*.rpm' \) -print
