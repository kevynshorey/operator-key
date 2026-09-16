# Luna Intent Reasoning

**Status:** IMPLEMENTED — RELEASE CANDIDATE

## Goal

Turn the narrow lexical `INTENT /` field into an assisted command-planning surface. An operator can describe an outcome in ordinary language; GPT-5.6-Luna interprets it, chooses only from the checked-in Operator Key catalog, and returns an ordered command structure with concise reasoning.

## Product contract

- Local search remains instant, offline, and authoritative.
- `Reason with Luna` is an explicit native-only action. It never runs merely because text changed.
- The operator's intent and a bounded catalog candidate set are sent to OpenAI through the locally installed, authenticated Codex CLI.
- Browser mode never invokes Codex and explains that reasoning requires the native companion.
- Luna may select only catalog entry IDs supplied by Operator Key. The app reconstructs command text, product, safety, availability, and provenance from the embedded catalog; model-authored command text is never trusted.
- Luna returns one to five ordered recommendations, a summary, assumptions, and a purpose/input hint for each step.
- Reasoning never copies, inserts, executes, or sends Enter. Existing copy and guarded insertion controls remain separate and continue to enforce catalog identity and safety.
- Red and unavailable entries remain visibly constrained by the existing action boundary.

## Architecture

1. The frontend builds a deterministic candidate pool of at most 220 entry IDs: exact local matches first, broad any-term matches second, then a product/task-diverse fallback.
2. A new Tauri command validates the intent and IDs, reconstructs trusted candidate records from the embedded catalog, and invokes `codex exec` with exact argv:
   - model `gpt-5.6-luna`
   - ephemeral session
   - ignored user config and project rules
   - empty isolated working directory
   - root-deny permission profile with only the private workspace writable
   - approval policy `never`
   - closed JSON output schema
3. The runner uses a hard deadline, bounded stdin/stdout/files, restrictive temporary-file modes, and complete cleanup.
4. The response parser rejects unknown fields, malformed or oversized strings/arrays, duplicate or unknown IDs, out-of-range sequence values, and invalid confidence values.
5. The frontend renders an `INTENT STRUCTURE` panel and uses the validated recommendation order as the active result lane. Changing the intent or filters clears stale reasoning.

## UX

- Keep the existing precision-console visual system.
- Relabel the prompt from a low-scope lookup to `DESCRIBE OUTCOME /` with an example that invites a full sentence.
- Add a tactile `REASON WITH LUNA` control and an explicit `ALT+ENTER` shortcut.
- Show `LOCAL MATCH` while typing and `LUNA STRUCTURE` after successful reasoning.
- Render the summary, assumptions, ordered steps, confidence, exact catalog command, purpose, and input hint.
- Provide `RETURN TO LOCAL SEARCH` without discarding the typed intent.
- Surface missing Codex, signed-out state, unavailable model, timeout, and malformed output as actionable errors without implying success.

## Privacy and availability

GPT-5.6-Luna is the selected fast reasoning model and requires an authenticated Codex CLI session. Operator Key discloses that reasoning sends the entered intent plus bounded command fields shown in the local catalog to OpenAI. Source paths and provenance are stripped; no files, secrets, shell history, configuration values, or terminal contents are included in the prompt.
