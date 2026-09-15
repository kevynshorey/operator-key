# Operator Key MVP Implementation Plan

> For Hermes: Use subagent-driven-development skill to implement this plan task-by-task.

Goal: Build a production-quality Omarchy overlay that searches the generated command catalog by intent and safely copies or inserts selected commands.

Architecture: A Rust/Tauri desktop shell will host a lightweight TypeScript interface. A Rust adapter layer will gather local context and execute catalog refreshes; the UI will search an indexed local catalog without a network dependency. Direct command execution remains disabled in the MVP.

Tech Stack: Tauri 2, Rust, TypeScript, Vite, SQLite, Vitest, Playwright.

---

## Task 1: Freeze the catalog contract

Objective: Convert the prototype JSON shape into a versioned schema with fixtures.

Files:
- Create: `schema/catalog.schema.json`
- Create: `tests/fixtures/catalog.minimal.json`
- Modify: `scripts/build_catalog.py`
- Test: `tests/test_catalog.py`

Steps:
1. Add a failing test validating required fields and enum values.
2. Run `python3 -m unittest discover -s tests -v` and verify failure.
3. Add the schema and validation helper using only the standard library.
4. Regenerate `data/catalog.json`.
5. Run tests and JSON validation.
6. Commit as `feat: define catalog contract`.

## Task 2: Normalize chords and conflicts

Objective: Make modifier-order variants comparable and surface cross-context conflicts.

Files:
- Create: `scripts/chords.py`
- Modify: `scripts/build_catalog.py`
- Test: `tests/test_chords.py`

Steps:
1. Write failing cases for Omarchy, terminal, and plus-delimited chord forms.
2. Implement canonical modifier ordering without changing the displayed chord.
3. Build conflict sets keyed by canonical chord and overlapping context.
4. Verify intentional duplicate press/release entries remain intact.
5. Commit as `feat: detect shortcut conflicts`.

## Task 3: Complete local adapters

Objective: Capture user overrides and agent customization files.

Files:
- Create: `scripts/adapters/omarchy.py`
- Create: `scripts/adapters/hermes.py`
- Create: `scripts/adapters/claude.py`
- Create: `scripts/adapters/codex.py`
- Modify: `scripts/build_catalog.py`
- Test: `tests/test_adapters.py`

Steps:
1. Add fixture-driven failing parser tests.
2. Move current parser logic into isolated adapters.
3. Add Omarchy override, Claude custom command/keybinding, and Codex config readers.
4. Mark default, override, disabled, and version-gated records explicitly.
5. Verify online and `--offline` generation.
6. Commit as `refactor: isolate catalog adapters`.

## Task 4: Scaffold the Tauri overlay

Objective: Produce a launchable, keyboard-operable application shell.

Files:
- Create: `package.json`
- Create: `src-tauri/**`
- Create: `src/**`
- Create: `vite.config.ts`
- Test: `src/**/*.test.ts`

Steps:
1. Add a failing smoke test for the search screen.
2. Scaffold Tauri and Vite without template visual styles.
3. Implement the industrial instrument-panel design tokens.
4. Render search, active context, result card, and alternatives lane.
5. Verify keyboard-only navigation and reduced-motion mode.
6. Run unit tests and production build.
7. Commit as `feat: add operator overlay shell`.

## Task 5: Implement intent search

Objective: Match the CLI proof-of-concept ranking in the overlay.

Files:
- Create: `src/search/index.ts`
- Create: `src/search/index.test.ts`
- Modify: `src/App.tsx`

Steps:
1. Port exact-command, alias, task, description, and product ranking tests.
2. Implement indexed in-memory search.
3. Add product, interface, task, and safety filters.
4. Add reverse chord lookup.
5. Verify results against fixed catalog fixtures.
6. Commit as `feat: add task-first command search`.

## Task 6: Add safe output actions

Objective: Let the operator copy or insert a selection without direct execution.

Files:
- Create: `src-tauri/src/actions.rs`
- Modify: `src/App.tsx`
- Test: `src/actions.test.ts`

Steps:
1. Test action availability by safety level and interface.
2. Implement clipboard copy.
3. Implement terminal insertion only after confirming the detected target window.
4. Ensure no code path executes the inserted command or sends Enter.
5. Add an explicit red-action warning state.
6. Commit as `feat: add guarded copy and insert actions`.

## Task 7: Integrate Omarchy

Objective: Launch the overlay globally and report binding conflicts before installation.

Files:
- Create: `scripts/install-omarchy-binding.py`
- Create: `docs/INSTALL.md`
- Test: `tests/test_install_binding.py`

Steps:
1. Parse the current active bindings.
2. Propose an unused chord rather than assuming `Super+?` is free.
3. Preview the exact `bindings.lua` change.
4. Require confirmation before writing the user override.
5. Reload Hyprland and verify the overlay opens.
6. Commit as `feat: integrate Omarchy launcher binding`.

## Task 8: End-to-end verification

Objective: Prove core flows on the installed Omarchy environment.

Status: Complete. Exact evidence is recorded in `docs/VERIFICATION.md`; the installed standalone release is bound to `SUPER + U`.

Files:
- Create: `tests/e2e/operator-key.spec.ts`
- Create: `docs/VERIFICATION.md`

Steps:
1. Regenerate the catalog and compare emitted Omarchy count with the source command.
2. Test `review code`, `resume session`, `move window`, and `Ctrl+B` reverse lookup.
3. Test copy and insertion into a disposable terminal.
4. Confirm red actions cannot execute.
5. Run unit tests, lint, production build, and Playwright smoke tests.
6. Record exact evidence in `docs/VERIFICATION.md`.
7. Commit as `test: verify operator overlay workflows`.
