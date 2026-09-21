# Apprentice Learning Surface

**Status:** IN PROGRESS

## Goal

Turn Operator Key from a lookup instrument into a teaching instrument. A new operator who
knows the outcome but not the terminal, the agent, or Linux should be able to type an
ordinary sentence, watch the interface complete their thought, receive a correct command
they understand, and be told what responsible work comes next.

This slice adds three deterministic local engines and the interface that carries them. It
does not weaken the existing trust boundary.

## Problem

Today the operator must already know the vocabulary. `DESCRIBE OUTCOME /` accepts a
sentence, but:

- Nothing completes the sentence, so the operator must supply the exact term the catalog
  already knows.
- The result explains *what* the command is, never *what its parts mean*, so using
  Operator Key does not make the operator better at the terminal.
- A command is delivered as a terminal act. Nothing raises whether verification, code
  checks, security review, iteration, or a recovery path is warranted.
- Luna reasoning is the only assisted path and it requires the native companion plus an
  authenticated Codex session. Everything below works offline, instantly, in both runtimes.

## Non-goals

- No execution. Copy and guarded insertion remain the only output actions.
- No change to the Luna trust boundary, candidate pool, or response validation.
- No network calls, secrets, shell history, or filesystem reads in the new engines.
- No LLM dependency: every engine in this slice is deterministic and offline.

## Design

### 1. Predictive intent (`src/predict.ts`)

A deterministic language model built from the checked-in catalog only.

- `createPredictionIndex(entries)` derives three corpora: whole phrases (descriptions,
  task groups, aliases, command text), unigram frequencies, and bigram transitions.
- `predictIntent(index, query, limit)` returns ranked suggestions of three kinds:
  - `phrase` — the whole typed query is a prefix of a known catalog phrase.
  - `completion` — completes the word currently being typed.
  - `next-word` — predicts the following word from bigram transitions.
- Each suggestion carries `ghost`, the text beyond what the operator typed, so the
  interface can render inline ghost text accepted with `Tab`.
- `starterPrompts(index, limit)` seeds an empty field with real, achievable intents.

Ranking is frequency-ordered then alphabetical, so output is stable across runs.

### 2. Follow-up engine (`src/followups.ts`)

Answers the operator's real next question: *is this command enough?*

`buildFollowUps(index, entry, limit)` reads signals from the selected catalog entry —
`destructive`, `safety_level`, `task_group`, `product`, `interface`, and command and
description tokens — and raises up to five classes:

| Class | Operator question |
|---|---|
| `verify` | Did it actually work? |
| `quality` | Do code checks need to run? |
| `security` | Does this need a security review? |
| `iterate` | Will this need to repeat or run in parallel? |
| `recover` | How do I undo this? |

Each class carries a priority (`required`, `recommended`, `optional`) and a rationale
written from that entry's own signals, not a generic template.

**Trust boundary:** every follow-up action is resolved through the existing local search
index and is therefore a real catalog entry with real provenance, safety, and availability.
The engine never authors command text. A class that resolves to no catalog entry is still
shown with its question and rationale, and states that the catalog holds no command for it.

### 3. Teaching layer (`src/teach.ts`)

Makes the command itself legible.

- `createTeachingIndex(entries)` maps product-scoped command and flag tokens to the catalog
  entries that document them.
- `buildCommandLesson(teachingIndex, entry)` returns:
  - **Anatomy** — the command split into tokens, each classified (`program`,
    `subcommand`, `flag`, `placeholder`, `modifier`, `key`, `slash-command`, `path`) and
    explained in plain English. A flag that exists in the catalog links to its entry, so
    the explanation is sourced, not invented.
  - **Glossary** — concepts this command depends on (session, flag, daemon, worktree,
    branch, elevated privilege, standard output, and similar), triggered by its own tokens.
  - **Safety briefing** — what the safety level means for this specific command.
  - **Practice hint** — the safe way to try it.

Two disclosure modes: `apprentice` shows anatomy, glossary, and follow-ups expanded;
`operator` collapses them. The mode is interface state only.

### 4. Interface

- Inline ghost text in the intent field, accepted with `Tab` or `→` at the end of input.
- A prediction rail under the field listing the ranked alternatives, clickable.
- `LEARN` panel in the command stage carrying anatomy, glossary, and the safety briefing.
- `NEXT MOVES` panel carrying the follow-up classes, each expandable to its catalog actions.
- An `APPRENTICE` / `OPERATOR` toggle in the masthead, defaulting to apprentice on first
  run so a new user is taught by default.
- Starter prompts on an empty field so the instrument is never a blank box.

## Verification

- Unit tests for all three engines: determinism, ghost-text composition, bigram
  transitions, signal-to-class rules, priority assignment, catalog-only resolution,
  token classification, and flag sourcing.
- Component tests: ghost render and `Tab` acceptance, prediction rail selection, follow-up
  rendering and priority order, lesson rendering, mode toggle.
- Existing suites must stay green: catalog, search, intent, actions, overlay, runtime,
  styles, App.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all clean.
- Playwright and native verification unchanged and still passing.
