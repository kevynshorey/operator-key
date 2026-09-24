#!/usr/bin/env bash
# Install the exact built .deb in an approved distro without mutating the host.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'usage: %s <package.deb> <ubuntu-24.04|debian-13>\n' "$0" >&2
  exit 2
fi

case "$2" in
  ubuntu-24.04) image=ubuntu:24.04 ;;
  debian-13) image=debian:13-slim ;;
  *) printf 'unsupported distro: %s\n' "$2" >&2; exit 2 ;;
esac

package=$(realpath -e -- "$1")
script=$(realpath -e -- "$(dirname "${BASH_SOURCE[0]}")/container-launch-smoke.sh")
if [[ ! -f "$package" || "$package" != *.deb ]]; then
  printf 'expected one regular .deb package\n' >&2
  exit 1
fi
# Docker --mount is comma-delimited; a surprising path must not change mount options.
if [[ "$package" == *,* || "$script" == *,* ]]; then
  printf 'commas in bind-mount paths are not supported\n' >&2
  exit 1
fi

before=$(sha256sum "$package")
printf 'Install/launch smoke: %s on %s\n' "$(basename "$package")" "$image"
docker run --rm --pull=always \
  --mount "type=bind,source=${package},target=/opt/operator-key.deb,readonly" \
  --mount "type=bind,source=${script},target=/opt/container-launch-smoke.sh,readonly" \
  "$image" bash /opt/container-launch-smoke.sh
if [[ "$before" != "$(sha256sum "$package")" ]]; then
  printf 'package bytes changed during compatibility smoke\n' >&2
  exit 1
fi
printf 'PASS: exact package installed and launched on %s\n' "$2"
