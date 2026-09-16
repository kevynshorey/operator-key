# Verification evidence

Verified on 2026-09-16 against application-bearing source commit `24b19c8c4757826230dffaafd2db5da9c7e765fc` on Omarchy 4.0.3-1.

## Installed launcher

- Physical shortcut: `SUPER + U` (Command + U on the connected Apple keyboard)
- Managed binding: `o.bind("SUPER + U", "Operator Key", o.launch("/home/kevo/.local/bin/operator-key"))`
- Installed path: `/home/kevo/.local/bin/operator-key`
- Release SHA-256: `7a4297de42da9c7632119ea0bc72ab14413cbc9ef3619ba1b9cdaad09a6168d7`
- Source and installed hashes matched exactly.
- The installer observed a new `operator-key` client after the physical shortcut press and verified `/proc/<pid>/exe` resolved exactly to the installed path.
- Live readback showed one `Operator Key` binding at modifier mask 64, key `U`.

The installer uses only the standalone `src-tauri/target/release/operator-key` artifact. Plain `cargo build` development binaries are not accepted as the default because they load Tauri's development URL rather than embedded assets.

## Catalog

Fresh online and offline catalog generation matched after excluding `generated_at`:

- Total entries: 1,303
- Omarchy: 228
- Hermes: 707
- Claude Code: 281
- Codex: 87
- Deterministic conflict groups: 25
- Live Omarchy rows: 228, including `SUPER + U` → `Operator Key`

The generated catalog passed the checked-in schema and JSON parsing.

## Automated gates

All gates ran from the repository root:

- Vitest: 63/63 passed across 7 files
- Playwright: 8/8 passed with system Chromium; the constrained local host used the documented explicit `/dev/shm` opt-in
- Python: 92/92 passed
- Rust: 26/26 passed
- TypeScript typecheck: passed
- ESLint: passed with zero warnings
- Cargo formatting: passed
- Cargo check: passed
- Production Tauri no-bundle build: passed
- `git diff --check`: passed

- The Vite production build emitted the documented embedded-catalog advisory: approximately 960.92 kB minified and 148.85 kB gzip. This is non-blocking and expected for the complete local-first catalog.

## Browser workflows

Playwright verified:

- Task-first searches for `review code`, `resume session`, and `move window`
- Reverse lookup for `Ctrl+B`
- Product, interface, task, and safety filters
- Keyboard selection and viewport visibility
- Copy behavior
- `Ctrl+Enter` remaining inert
- Green terminal insertion behavior through the mocked browser-native boundary
- Red `hermes logout` remaining warned and copy-only
- Operability at 820×560 with large-text mode
- Browser-only copy behavior with native insertion unavailable
- 390×844 touch targets of at least 44×44 in populated and empty states
- Genuine horizontal overflow and end affordance for product and task rails
- Full `/code-review`, `/claude-api`, `/doctor`, and `/bug` descriptions above the initial mobile fold
- Keyboard selection scrolling only the result list while the page remains at scroll position zero

## Native workflows

The compositor-level native smoke used exact argv with a disposable Foot terminal and isolated tmux server:

- Search query: `hermes status`
- Clipboard result matched exactly: `hermes status`
- Guarded insertion placed the same literal text at an unsubmitted prompt
- The prompt count remained one, proving no Enter was sent and the command did not execute
- No red action was invoked
- Temporary terminal, tmux, and Operator Key processes were cleaned up
- The prior clipboard value and focused window were restored when available
- No new WebKitWebProcess core dump appeared during the successful release smoke
- The installed binary hash matched the reviewed release artifact exactly after installation

A smoke attempted while the install-verification window was intentionally still open could not hand focus back to the disposable terminal because the existing always-on-top Operator Key window remained present. After closing that verification window, the same installed-artifact smoke passed. Normal use is one overlay instance at a time.

## Reviewed fixes

- `0e114df579bdc39e38b1a524e595510808ade4d1` — WebKit-safe result reconciliation and pending-state accessibility: independently approved with no findings.
- `1de630ee56e915c0d44d00be818cdd8687a592ab` — current Hyprland Lua focus dispatcher with strict address validation and target revalidation: independently approved with no blocking findings.
- `24b19c8c4757826230dffaafd2db5da9c7e765fc` — browser-safe Operator Deck and mobile ergonomics: exact-snapshot specification and code-quality/security reviews both passed with no findings.

The approved branch was fast-forwarded into local `main`. No remote is configured, so no remote push or hosted deployment was performed.
