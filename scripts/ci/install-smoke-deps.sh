#!/usr/bin/env bash
set -euo pipefail

# Disposable distro smoke containers can see stale Ubuntu security indexes while
# the archive mirrors rotate. Refresh once more if package retrieval fails, but
# never let the install/launch compatibility gate pass without installing.
apt-get -o Acquire::http::No-Cache=true -o Acquire::Retries=2 -o APT::Update::Error-Mode=any update -qq
if ! apt-get -o Acquire::http::No-Cache=true -o Acquire::Retries=2 install -y -qq --no-install-recommends /opt/operator-key.deb xvfb xauth x11-utils util-linux; then
  printf 'Package retrieval failed; refreshing repository indexes once before retry.\n' >&2
  apt-get -o Acquire::http::No-Cache=true -o Acquire::Retries=2 -o APT::Update::Error-Mode=any update -qq
  apt-get -o Acquire::http::No-Cache=true -o Acquire::Retries=2 install -y -qq --no-install-recommends /opt/operator-key.deb xvfb xauth x11-utils util-linux
fi
