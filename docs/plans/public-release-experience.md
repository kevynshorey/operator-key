# Public release experience

The user requested: “build it and launch it”. Preserve local-first operation, no arbitrary execution, no automatic Enter, native catalog validation and opt-in reasoning. Baseline e444761. Work branch feat/public-release-experience.

## Product/design intent

Keep the existing industrial instrument-panel identity: graphite, warm white, cyan focus, explicit non-color safety text, etched borders and command keycaps. References already established in DESIGN_INTENT: Alfred/Raycast immediate command selection and Linear command-menu density; translate their behavior, not branding. Remove promotional hierarchy from the working surface. Find is the primary default, Learn a separate workspace, Settings a separate workspace. On mobile put selected action before the long results list. Respect reduced motion, readable body text, keyboard focus, 44px interactive targets and large text.

## Workstreams / acceptance

1. Frontend workspace: Find/Learn/Settings, persist validated non-secret preferences, favorites and opt-in/clearable recent successful copies, explicit explain mode, compact status, truthful reasoning disclosure, exact lesson/follow-up selection across filters. Preserve all existing functional capabilities. Behavioral tests first, unit and browser evidence. Do not add fake status or simulated operations.
2. Teaching and catalog safety: conservative semantics; never describe green as necessarily read-only, danger before hotkey practice, distinguish flags/notation from runnable commands, correct known unsafe green classifications through generator policy and checked-in catalog with regression tests. Do not regenerate personal machine data.
3. Native health/settings: expose safe catalog source/fallback health and validated local-reasoning configuration read/save/test/reset without secrets; frontend wiring requires explicit backend contract. Preserve provider constraints. Add safe default Hyprland floating presentation without rewriting user config, if feasible and supported; otherwise targeted launch integration with verified bounds. Rust tests, serialize compilation with parent.
4. Parent: integration, browser E2E mock repairs + CI required job, end-user install/update/recovery docs, full verification and independent spec then quality review, standalone production build, backup/install/readback hashes, native launch and real interaction.

## Release gate

Typecheck, lint, unit suites, Python, Rust fmt/clippy/tests, browser E2E including small viewport and preferences, dependency audits, privacy guard, independent review, production Tauri build, exact installed hash and native visual/action smoke. No public release claim without public artifact/workflow verification. Record remaining platform scope honestly; no claim macOS/Windows/X11 support without implementation and tests.

## Not part of this release

Cloud accounts, billing, autonomous execution, remote model default, unsigned unattended updater, unvalidated generated commands. Full parameterized command-builder changes require a separately audited native contract and are deferred rather than implemented by bypassing validation.
