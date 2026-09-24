# Verification evidence

This is historical evidence for the specific commits and artifacts named below,
not verification of the current OpenCode feature or a newly published release.
See [Optional reasoning](REASONING.md) for current provider setup and disclosures.

Verified on 2026-09-16 against Luna application-bearing source commit `a9ff3d3ab0f0f16c7d77573f824d539fb140cc01` on Omarchy 4.0.3-1.

## Luna intent reasoning release candidate

- Selected model: `gpt-5.6-luna` through authenticated Codex CLI `0.154.0`.
- The operator must explicitly choose `Reason with Luna` or press `Alt+Enter`; typing never invokes the provider.
- Provider-bound data is limited to the entered intent and bounded catalog fields. Source paths, provenance, files, secrets, terminal contents, configuration, and history are excluded.
- The Codex process runs ephemerally in a private workspace with a root-deny permission profile, tool surfaces disabled, closed schema output, a hard deadline, and process-group cleanup.
- A real authenticated Luna call passed through `reason_about_intent_with`, returned a schema-valid plan, and selected only the two supplied exact catalog IDs.
- Independent exact-snapshot security/correctness review passed commit `52f1eeb456cc5ea2d6d9b0ccd2762fa1ceb12544`; the subsequent accessibility remediation is commit `a9ff3d3ab0f0f16c7d77573f824d539fb140cc01`.
- Release artifact: `src-tauri/target/release/operator-key`
- Release-candidate SHA-256: `6f0afb8b745b16609833ac0b54dce6da280079821bd7c5ceab4cffac1fea4c40`

## Installed baseline before Luna cutover

- Physical shortcut: `SUPER + U` (Command + U on the connected Apple keyboard)
- Managed binding: `o.bind("SUPER + U", "Operator Key", o.launch("~/.local/bin/operator-key"))`
- Installed path: `~/.local/bin/operator-key`
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

- Vitest: 89/89 passed across 8 files
- Playwright: 9/9 passed with system Chromium
- Python: 92/92 passed
- Rust: 46/46 passed, plus a separate authenticated live Luna test pass
- TypeScript typecheck: passed
- ESLint: passed with zero warnings
- Cargo formatting: passed
- Cargo check: passed
- Cargo Clippy (`--all-targets --all-features -D warnings`): passed
- Production Tauri no-bundle build: passed
- `git diff --check`: passed

- The Vite production build emitted the documented embedded-catalog advisory: approximately 969.10 kB minified and 151.18 kB gzip. This is non-blocking and expected for the complete local-first catalog.

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
- Explicit Luna invocation with exact bounded candidate IDs and no automatic provider call
- Ordered catalog-bound plan rendering with assumptions, gaps, confidence, purpose, input hints, and safety
- Pending-state lock including Escape, live availability/progress announcements, stale-plan clearing, and return to local search

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
- The Luna release candidate independently passed the same exact-copy and guarded-unsubmitted-insertion smoke from its release artifact path

A smoke attempted while the install-verification window was intentionally still open could not hand focus back to the disposable terminal because the existing always-on-top Operator Key window remained present. After closing that verification window, the same installed-artifact smoke passed. Normal use is one overlay instance at a time.

## Reviewed fixes

- `0e114df579bdc39e38b1a524e595510808ade4d1` — WebKit-safe result reconciliation and pending-state accessibility: independently approved with no findings.
- `1de630ee56e915c0d44d00be818cdd8687a592ab` — current Hyprland Lua focus dispatcher with strict address validation and target revalidation: independently approved with no blocking findings.
- `24b19c8c4757826230dffaafd2db5da9c7e765fc` — browser-safe Operator Deck and mobile ergonomics: exact-snapshot specification and code-quality/security reviews both passed with no findings.
- `52f1eeb456cc5ea2d6d9b0ccd2762fa1ceb12544` — Luna-assisted intent reasoning, root-deny Codex boundary, catalog-bound plans, and live provider proof: exact-snapshot security/correctness review passed with no findings.
- `a9ff3d3ab0f0f16c7d77573f824d539fb140cc01` — strict pending lock, assistive announcements, and Luna documentation normalization.

The Luna release candidate is awaiting final commit-bound accessibility review before fast-forwarding local `main` and installing the exact reviewed artifact. No remote is configured, so no remote push or hosted deployment is applicable.
