#!/usr/bin/env bash
# Runs only inside the short-lived Ubuntu/Debian Docker container.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

bash /opt/install-smoke-deps.sh

test -x /usr/bin/operator-key
# ldd normally exits successfully even when it prints "not found"; reject that output.
ldd -r /usr/bin/operator-key > /opt/linked-libraries.txt
if grep -Fq 'not found' /opt/linked-libraries.txt; then
  printf 'ELF dependencies could not be resolved:\n' >&2
  grep -F 'not found' /opt/linked-libraries.txt >&2
  exit 1
fi

useradd --create-home --shell /bin/bash smoke
smoke_home=$(getent passwd smoke | cut -d: -f6)
test -d "$smoke_home"
install -d -m 0700 -o smoke -g smoke "$smoke_home/runtime"
# A real non-root GUI launch, bounded even if WebKit or Xvfb stalls. A mapped
# application window is package/startup evidence, not a full native-action test.
timeout --signal=TERM 60s runuser -u smoke -- \
  env XDG_RUNTIME_DIR="$smoke_home/runtime" \
  xvfb-run -a --server-args='-screen 0 1024x768x24' \
  bash -euo pipefail -c '
    /usr/bin/operator-key > "$HOME/operator-key.log" 2>&1 &
    app=$!
    trap "kill $app 2>/dev/null || true; wait $app 2>/dev/null || true" EXIT
    found=0
    for attempt in {1..20}; do
      if ! kill -0 "$app" 2>/dev/null; then
        printf "native process exited before displaying a window\n" >&2
        sed -n "1,60p" "$HOME/operator-key.log" >&2
        exit 1
      fi
      if xwininfo -root -tree | grep -Eiq "operator.key"; then
        found=1
        break
      fi
      sleep 1
    done
    if [[ "$found" -ne 1 ]]; then
      printf "no Operator Key window appeared\n" >&2
      sed -n "1,60p" "$HOME/operator-key.log" >&2
      exit 1
    fi
    test "$(readlink "/proc/$app/exe")" = /usr/bin/operator-key
    printf "PASS: package executable opened its own window as a non-root user\n"
  '
