# Universal Shortcut Reliability Implementation Plan

> **For Hermes:** Execute the approved A → B → C sequence with strict TDD. Keep all host-specific keyboard/binding data out of the repository and never apply a desktop binding without a separate explicit APPLY confirmation.

**Goal:** Make shortcut lookup honest and useful across keyboard layouts, host desktops, and upstream keybinding changes, while offering a safe opt-in path for user-defined aliases.

**Architecture:** Treat a chord query as an exact reverse lookup, not natural-language search. Add a versioned, source-backed history ledger for retired/moved bindings. Query current bindings and keyboard hints through an advisory native environment contract; unknown means unknown, never “not bound.” Extend the Omarchy installer with named, conflict-checked aliases whose preview is read-only and whose apply remains separately confirmed and rollback-safe.

**Tech Stack:** TypeScript/React + Vitest, Rust/Tauri, Python 3 stdlib, Hyprland IPC; no new runtime dependencies or network access from the app.

---

## Task 1: Make chord-shaped searches exact-only

**Objective:** Prevent `SUPER + A` from returning unrelated fuzzy matches such as workspace 7.

**Files:**
- Modify: `src/search/index.ts`
- Test: `src/search/index.test.ts`

**Acceptance:** An exact chord returns its matching entries; a valid chord absent from the catalog returns no fuzzy results; plain-language searches retain their current ranking/relaxation behavior; modifier order and aliases remain normalized.

**Verification:** `npm test -- src/search/index.test.ts` and `npm run typecheck`.

## Task 2: Add a validated, source-backed moved-shortcut ledger

**Objective:** Explain known historical moves without implying that an old binding is active now.

**Files:**
- Create: `data/shortcut-history.json`
- Create: `src/shortcutHistory.ts`
- Test: `src/shortcutHistory.test.ts`
- Modify: `src/App.tsx` and `src/styles.css`

**Acceptance:** The Omarchy ChatGPT move from `SUPER + A` to `SUPER + SHIFT + A` is represented with exact upstream-tag URLs and bounded version ranges. Invalid ledger data fails closed. The empty-result view distinguishes “not in current catalog” from “historically moved,” and labels history as historical/advisory.

**Verification:** Focused Vitest tests, app tests, full lint/typecheck/build; inspect the rendered copy for temporal ambiguity.

## Task 3: Define and test a runtime shortcut-environment contract

**Objective:** Report only what this installed host can actually verify, independently from build-time catalog data.

**Files:**
- Create: `src/shortcutEnvironment.ts`
- Test: `src/shortcutEnvironment.test.ts`
- Modify: `src/actions.ts`, `src-tauri/src/actions.rs`, `src-tauri/src/lib.rs`, and `src/App.tsx`

**Acceptance:** The native command returns a bounded advisory snapshot. On Hyprland it reads active bindings and keyboard/layout hints using read-only queries. Outside a supported desktop, it returns an explicit unknown/unavailable state. No binding status or keyboard detail gates catalog search, copy, or insert. Parsing is fixture-tested for malformed, empty, duplicate, and modifier-order cases.

**Verification:** Focused TypeScript and Rust tests; `npm run test:native`; Rust formatting/clippy/test gates; no live config mutation.

## Task 4: Render keyboard-aware shortcut verdicts

**Objective:** Tell the operator whether a chord is active here, historical only, unavailable from the local probe, or associated with a detectable keyboard hint.

**Files:**
- Modify: `src/App.tsx`, `src/styles.css`, `src/actions.ts`
- Test: `src/App.test.tsx` and `src/shortcutEnvironment.test.ts`

**Acceptance:** A live exact match names its local binding; a live exact absence says “not active in the detected binding set,” not “impossible”; unknown probe state says it cannot verify. Canonical chords remain searchable using Super/Meta/Win/Command and Alt/Option/symbol aliases. Fn-layer or physical-key claims are made only when the probe can support them.

**Verification:** Focused app and search tests; keyboard-accessibility/ARIA assertions; read the UI as a new operator.

## Task 5: Extend the Omarchy installer with named alias bundles

**Objective:** Let users preview and optionally apply safe aliases without arbitrary shell-command input.

**Files:**
- Modify: `scripts/install-omarchy-binding.py`
- Test: `tests/test_install_binding.py`
- Modify: `docs/USER_GUIDE.md` and `docs/INSTALL.md`

**Acceptance:** Aliases are selected from a closed allowlist of known actions; each chord is canonicalized and checked against the live binding set after excluding the installer’s own prior managed block. The preview shows every proposed byte, conflict, and rollback step. Apply requires exact typed confirmation, preserves a durable backup, atomically writes only its marked block, reloads, verifies active bindings, and rolls back on failure. No arbitrary command-string flag is added.

**Verification:** TDD for parsing, collision rejection, managed-block update/uninstall, rollback, and byte preservation; all `tests/test_install_binding.py`; no apply during this task.

## Task 6: Produce this host’s preview only

**Objective:** Prepare the approved ChatGPT compatibility alias and a conflict-checked screenshot alias for Kevyn’s current Omarchy session.

**Files:** None in the public repository; do not write `bindings.lua`.

**Acceptance:** Read the current live binds and exact current config, show the proposed marked block and unified diff, verify the selected key is unbound and uses a physical key accessible on the current keyboard, and confirm the original file digest is unchanged. The preview makes no system change.

## Task 7: Full verification and exact-snapshot review

**Objective:** Prove the complete change and preserve the current project release posture.

**Files:** All changed files above.

**Verification:** Focused tests, complete TypeScript/Python/Rust/native/E2E suites applicable to the diff, lint, typecheck, build, `git diff --check`, public-data privacy scan, independent read-only review bound to the final commit, and clean exact-snapshot authentication. Do not publish a release or change this machine’s bindings as part of verification.
