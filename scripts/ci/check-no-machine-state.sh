#!/usr/bin/env bash
#
# Refuse to publish another machine's state.
#
# Operator Key is built from binaries installed on the developer's own machine, so it is
# structurally easy to commit that machine's fingerprint: an absolute home path in a doc,
# a personal email in a config, or the generated freshness report that records which
# versions one particular laptop had installed. A fresh clone must never display another
# operator's environment as if it were their own, and a public repository must not carry
# its author's identifiers.
#
# This runs against tracked files only, so an operator's own untracked config is ignored.
set -euo pipefail

status=0

fail() {
  printf '  FAIL: %s\n' "$1" >&2
  status=1
}

echo "== machine state =="

# Machine drift data. Correct behaviour is an absent file, which reads as "never checked".
if git ls-files --error-unmatch data/freshness.json >/dev/null 2>&1; then
  fail "data/freshness.json is tracked; it records one machine's installed versions"
else
  echo "  ok: data/freshness.json is not tracked"
fi

# An operator's reasoning config names their model and may name a key-bearing variable.
if git ls-files | grep -qE '(^|/)reasoning\.json$'; then
  fail "a reasoning.json is tracked; that file belongs outside the repository"
else
  echo "  ok: no reasoning.json is tracked"
fi

echo "== host paths =="

# Absolute home paths in tracked text. Docs must use $HOME or ~ so they read correctly on
# any machine.
#
# Test files are excluded deliberately. Several tests assert that host paths are STRIPPED
# from output or provenance, so they must contain a realistic path as an input fixture;
# forbidding it there would delete the evidence that the stripping works.
HOME_PATH_EXCLUDES=(
  ':!*.lock'
  ':!package-lock.json'
  ':!scripts/ci/check-no-machine-state.sh'
  ':!*test*'
  ':!*/tests/*'
)
if git grep -nIE '/home/[a-z0-9_-]+/|/Users/[a-z0-9_-]+/' -- "${HOME_PATH_EXCLUDES[@]}" >/dev/null 2>&1; then
  echo "  offending lines:" >&2
  git grep -nIE '/home/[a-z0-9_-]+/|/Users/[a-z0-9_-]+/' -- "${HOME_PATH_EXCLUDES[@]}" >&2
  fail "an absolute home path is tracked; use \$HOME or ~ instead"
else
  echo "  ok: no absolute home paths outside test fixtures"
fi

# The operator's own username must never appear, not even in a test fixture.
if [ -n "${OPERATOR_KEY_FORBID_USER:-}" ]; then
  if git grep -nIF "/home/${OPERATOR_KEY_FORBID_USER}/" -- ':!*.lock' ':!package-lock.json' \
    ':!scripts/ci/check-no-machine-state.sh' >/dev/null 2>&1; then
    git grep -nIF "/home/${OPERATOR_KEY_FORBID_USER}/" -- ':!*.lock' ':!package-lock.json' \
      ':!scripts/ci/check-no-machine-state.sh' >&2
    fail "the building operator's own home path is tracked"
  else
    echo "  ok: the building operator's username does not appear"
  fi
fi

echo "== personal identifiers =="

# A public repository should carry a noreply address, not a personal mailbox. GitHub's
# own users.noreply.github.com form is explicitly allowed.
if git grep -nIE '[a-zA-Z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud|proton(mail)?)\.[a-z]{2,}' -- \
  ':!*.lock' ':!package-lock.json' ':!scripts/ci/check-no-machine-state.sh' \
  ':!src-tauri/src/provider.rs' ':!*.test.ts' ':!*.test.tsx' ':!tests/*' >/dev/null 2>&1; then
  echo "  offending lines:" >&2
  git grep -nIE '[a-zA-Z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud|proton(mail)?)\.[a-z]{2,}' -- \
    ':!*.lock' ':!package-lock.json' ':!scripts/ci/check-no-machine-state.sh' \
    ':!src-tauri/src/provider.rs' ':!*.test.ts' ':!*.test.tsx' ':!tests/*' >&2
  fail "a personal email address is tracked; use a noreply address"
else
  echo "  ok: no personal email addresses"
fi

# Commit authorship must also be noreply, checked on the range this build can see.
if [ -n "${GITHUB_BASE_REF:-}" ]; then
  range="origin/${GITHUB_BASE_REF}..HEAD"
else
  range="HEAD~20..HEAD"
fi
if git rev-parse "${range%%..*}" >/dev/null 2>&1; then
  authors=$(git log --format='%ae%n%ce' "$range" 2>/dev/null | sort -u || true)
  if printf '%s\n' "$authors" |
    grep -qE '@(gmail|outlook|hotmail|yahoo|icloud|proton(mail)?)\.[a-z]{2,}$'; then
    fail "a commit in $range is authored from a personal address"
  else
    echo "  ok: commit authorship in $range is not a personal mailbox"
  fi
fi

echo "== private network detail =="

# RFC1918 and link-local addresses describe somebody's LAN. Loopback is expected and
# allowed, because the reasoning transport is deliberately loopback-only.
#
# Rust test files are exempt. The provider suite deliberately contains hostile endpoints —
# including the cloud metadata address 169.254.169.254 — as fixtures proving the transport
# refuses them before opening a socket. Deleting those strings to satisfy this guard would
# delete the SSRF protection they verify. A leak of a real LAN address into a *test* is
# the acceptable cost; the check still covers every non-test file.
NETWORK_FIXTURE_EXCLUDES=(
  ':!src-tauri/src/provider.rs'
  ':!*.test.ts'
  ':!*.test.tsx'
  ':!tests/*'
)
if git grep -nIE '\b(10\.[0-9]{1,3}|192\.168|172\.(1[6-9]|2[0-9]|3[01])|169\.254)\.[0-9]{1,3}\.[0-9]{1,3}\b' -- \
  ':!*.lock' ':!package-lock.json' ':!scripts/ci/check-no-machine-state.sh' \
  "${NETWORK_FIXTURE_EXCLUDES[@]}" >/dev/null 2>&1; then
  echo "  offending lines:" >&2
  git grep -nIE '\b(10\.[0-9]{1,3}|192\.168|172\.(1[6-9]|2[0-9]|3[01])|169\.254)\.[0-9]{1,3}\.[0-9]{1,3}\b' -- \
    ':!*.lock' ':!package-lock.json' ':!scripts/ci/check-no-machine-state.sh' \
    "${NETWORK_FIXTURE_EXCLUDES[@]}" >&2
  fail "a private network address is tracked"
else
  echo "  ok: no private network addresses"
fi

if [ "$status" -eq 0 ]; then
  echo
  echo "PASS: no machine state, host paths, personal identifiers or private addresses."
fi

exit "$status"
