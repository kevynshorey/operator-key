# Luna Intent Reasoning Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add native-only GPT-5.6-Luna reasoning that converts natural-language operator intent into a validated, ordered structure of exact catalog commands.

**Architecture:** The React layer builds a bounded, diverse pool of trusted catalog IDs. A new Tauri boundary reconstructs exact catalog metadata and invokes Codex Luna in an ephemeral private workspace under a root-deny permission profile, with tools disabled and a closed JSON schema. It validates the response fail-closed and returns ID-bound recommendations for rendering. Existing copy/insertion boundaries remain unchanged.

**Tech Stack:** React 19, TypeScript, Vitest, Playwright, Tauri 2, Rust/Serde, exactly Codex CLI 0.154.0.

---

### Task 1: Candidate-pool and response contracts

**Files:**
- Create: `src/intent.ts`
- Create: `src/intent.test.ts`

**Steps:**
1. Write RED tests for exact-first ordering, any-term semantic rescue, product/task diversity, filtering, stable dedupe, and 220-ID ceiling.
2. Add closed TypeScript contracts for Luna status, request, response, recommendations, confidence, and a native/browser reasoner interface.
3. Implement the deterministic candidate pool and browser/native reasoner adapters.
4. Run focused Vitest and typecheck.

### Task 2: Native Codex-Luna boundary

**Files:**
- Create: `src-tauri/src/intent.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml` only if a narrowly justified dependency is required.

**Steps:**
1. Write RED Rust tests for intent/ID bounds, catalog reconstruction, exact prompt payload, closed output, unknown/duplicate IDs, string/array limits, timeout/error classification, and cleanup.
2. Implement exact-argv Codex execution with an isolated mode-0700 directory, mode-0600 schema/output files, bounded prompt/output, 30-second deadline, child termination/reaping, and cleanup.
3. Use `gpt-5.6-luna`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check`, a root-deny/private-workspace permission profile, approval `never`, disabled tools, and JSON schema output.
4. Register status and reason commands with Tauri.
5. Run focused Rust tests, format, Clippy/check.

### Task 3: Intent composer and structure UI

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/styles.css`

**Steps:**
1. Write RED component tests for native Luna invocation, browser unavailability, explicit disclosure, pending lock, successful ordered structure, stale-plan clearing, exact ID mapping, error states, and no action execution.
2. Relabel and expand the intent affordance, add `REASON WITH LUNA` and `ALT+ENTER`, and retain local search/copy/insertion behavior.
3. Render the reasoning summary, assumptions, ordered exact commands, confidence, purpose, input hints, and return-to-local control.
4. Ensure native 820x560, web desktop, and 390x844 mobile remain operable.
5. Run focused Vitest, typecheck, lint, and build.

### Task 4: End-to-end verification and documentation

**Files:**
- Modify: `tests/e2e/operator-key.spec.ts`
- Modify: `README.md`
- Modify: `docs/VERIFICATION.md`

**Steps:**
1. Add browser/Tauri-boundary E2E coverage using a deterministic mocked reasoning response; prove ordered structure, exact catalog command mapping, copy-only browser behavior, responsive layout, and no execution path.
2. Document ChatGPT Pro/Codex login requirements, explicit data disclosure, `ALT+ENTER`, failure modes, and the local-only fallback.
3. Run all canonical gates: Vitest, typecheck, lint, Playwright, web build, Python, JSON, Rust fmt/test/check/clippy, native smoke, Tauri no-bundle release build, and `git diff --check`.
4. Freeze the exact diff, run independent specification review followed by code-quality/security review, remediate every Critical/Important finding, and re-freeze.
5. Commit the approved snapshot. Do not merge/install until the live Luna probe succeeds under the user's authenticated Codex account and the user approves the new version.
