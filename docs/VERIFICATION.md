# Verification evidence

Verified on 2026-09-15 against source commit `20a141b2a4adf30db5b394448bc9345d6a6e3110` on Omarchy 4.0.3-1.

## Installed launcher

- Physical shortcut: `SUPER + U` (Command + U on the connected Apple keyboard)
- Managed binding: `o.bind("SUPER + U", "Operator Key", o.launch("/home/kevo/.local/bin/operator-key"))`
- Installed path: `/home/kevo/.local/bin/operator-key`
- Release SHA-256: `287f5853ea58b82ce64cfe8c379fd8f8393bba8c6232dbcf0046136c3036cb62`
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

- Vitest: 52/52 passed across 6 files
- Playwright: 5/5 passed with system Chromium
- Python: 92/92 passed
- Rust: 26/26 passed
- TypeScript typecheck: passed
- ESLint: passed with zero warnings
- Cargo formatting: passed
- Cargo check: passed
- Production Tauri no-bundle build: passed
- `git diff --check`: passed

The Vite production build emitted the documented embedded-catalog advisory: approximately 958.81 kB minified and 148.15 kB gzip. This is non-blocking and expected for the complete local-first catalog.

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

A smoke attempted while the install-verification window was intentionally still open could not hand focus back to the disposable terminal because the existing always-on-top Operator Key window remained present. After closing that verification window, the same installed-artifact smoke passed. Normal use is one overlay instance at a time.

## Reviewed fixes

- `0e114df579bdc39e38b1a524e595510808ade4d1` — WebKit-safe result reconciliation and pending-state accessibility: independently approved with no findings.
- `1de630ee56e915c0d44d00be818cdd8687a592ab` — current Hyprland Lua focus dispatcher with strict address validation and target revalidation: independently approved with no blocking findings.

No remote push was performed.
