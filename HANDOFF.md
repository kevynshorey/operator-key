# Operator Key — Session Handoff

Written: 2026-09-21 (AST)
Repo: `/home/kevo/Work/operator-key`
Branch: `main` — HEAD `b09f520be0b5e28d023881da8bc4aba5bdd285ed`
Working tree: CLEAN (verified `git status --porcelain` empty)
Remote: **NONE CONFIGURED** — see Open Questions

---

## 1. What this product is

Operator Key is a local command instrument: a React + Tauri desktop app that indexes
every command, flag, slash-command and keybinding for four tools installed on the
machine (omarchy, hermes, claude-code, codex) and lets an operator find them by intent
("resume a session") rather than by memorising syntax.

The governing principle across every slice is **honesty over helpfulness**. The app is
worth using only because what it shows is true of the machine it runs on. Every design
decision below follows from that: it never invents an answer, never implies currency it
has not verified, never executes anything it has not been explicitly asked to, and says
"I cannot tell" rather than guessing. A confident wrong answer is the failure mode that
destroys the product.

Current catalog: **1,303 entries** (omarchy 228, hermes 706, claude-code 282, codex 87).

---

## 2. Original objective (user's words, verbatim)

Most recent request driving the last two slices:

> "this product must always be up to date with regular checks from the websites that make
> the tools we are using and also any changes in the repos etc, i think some kind of
> eductional aspect to this would also be a gret addition, how to use places like git hub
> and how to add skills etc using these portals brainsrorm how this could be implemented"

Then, as constraints:

> "cron should be weekly also remember this app will be installed on other machines as a
> github repo download so ensure all functions will be set that way also this should be in
> the future a web app if it becoms popular"

So the standing objective has three parts, in order:
1. **Freshness** — DONE (commit `892f273`, hardened in `b09f520`)
2. **Portability + web-app readiness** — DONE (commit `b09f520`)
3. **Educational layer, incl. git/GitHub** — **NOT STARTED. This is the next slice.**

---

## 3. Architecture and the rules that hold it together

These are decisions already made and approved. Do not relitigate them without asking.

**Capability lives at the edges.** Each behaviour is an importable engine module with its
own test file, not logic buried in `App.tsx`:

| Module | Responsibility |
|---|---|
| `src/predict.ts` | Ghost-text prediction of what the operator is typing |
| `src/followups.ts` | "What usually comes next", suggested never auto-run |
| `src/teach.ts` | Command anatomy + teaching glossary |
| `src/explain.ts` | Reverse lookup: explain a pasted shell command |
| `src/onboarding.ts` | Guided route; starts read-only, ends with recovery |
| `src/freshness.ts` | How far to trust the catalog right now |
| `src/catalog.ts` | Catalog load/parse/search index |
| `src/runtime.ts` | `"native"` vs `"web"` detection |

**Suggest and explain, never auto-run.** The audience is people being handed the tool,
not the author. Teaching outranks convenience everywhere.

**False alarms are the enemy.** A safety flag that fires wrongly trains operators to
ignore real warnings. Same logic governs the freshness banner: it is tiered so it does not
cry wolf. No keyword matching without an intent cross-check.

**The app never touches the network.** All network I/O is isolated in
`scripts/check_updates.py`, run from cron only. Network content can NEVER mutate
`catalog.json`; it writes advisory `data/freshness.json` only. A test greps the checker
source to prove the catalog path is never written — a comment is not a boundary.

**The catalog is built from local binaries**, which is the only reason it can be trusted.

---

## 4. Completed work (each verified, not assumed)

### `b478834` — apprentice learning surface
`predict.ts`, `teach.ts`, `followups.ts` + UI wiring.

### `1779edb` — guided onboarding + reverse lookup
`onboarding.ts`, `explain.ts`. Reverse lookup uses the same rules as catalog entries, so
a pasted command is explained with identical authority.

### `892f273` — freshness checking and honest staleness display
- `scripts/check_updates.py` (~360 lines): installed versions via `pacman -Q` and
  `--version`; upstream via GitHub releases API; conditional GET (ETag/Last-Modified) on
  docs so unchanged pages cost a 304 with no body; offline-safe.
- `src/freshness.ts` + banner in `App.tsx`.
- Fixed two real upstream bugs found while probing:
  - Codex docs **308-redirect**: `developers.openai.com/codex/developer-commands.md` →
    `learn.chatgpt.com/docs/developer-commands.md`. `urllib` followed it silently, so the
    catalog cited provenance it no longer read. Now `fetched_url` is recorded separately
    from `url` and every 30x is logged on stderr.
  - Omarchy repo moved `basecamp/omarchy` → `omacom/omarchy`.

### `b09f520` — honesty on machines that did not build the catalog
Three real bugs, all found by actually cloning the repo rather than reasoning about it:
- **Username leak**: 105 entries embedded `/home/kevo/...` in provenance. Now rendered
  `~/...` via `portable_path()` in `scripts/adapters/common.py`. A test fails the build if
  `/home/` or `/Users/` reappears anywhere in the catalog JSON.
- **Absent tools reported as "out of date"**: a clone with none of the tools installed got
  four `STALE` verdicts. `installed_here` is now its own state — stated once, excluded
  from all staleness/drift verdicts, and costs no network requests. When NOTHING
  catalogued is installed, the app leads with "this catalog describes a different machine"
  and points at `build_catalog.py`.
- **A search test passing by accident**: `"commit my changes"` matched one hermes flag
  only because its description was truncated mid-sentence, leaving the word "Uncommitted".
  Rebuilding cleaned the truncation and the match vanished. There are **no git commands in
  the catalog**, so the honest result is zero; the test now asserts that.

---

## 5. Verification status (re-run fresh at handoff, not copied from memory)

```
TypeScript:  240 tests passing, 18 test files   (npm test)
Python:      114 tests passing                  (python3 -m unittest discover -s tests)
Typecheck:   0 errors                           (npm run typecheck)
Lint:        clean, --max-warnings 0            (npm run lint)
Build:       succeeds                           (npm run build)
```

Verified by real execution, not simulation:
- Cloned the repo to a scratch dir and ran its suite there (108 tests at that commit).
- Simulated a bare machine by patching the version probe to raise `FileNotFoundError`;
  confirmed `not installed` instead of four false `STALE` rows.
- Served `dist/` over plain HTTP with **no Tauri present**: app reports
  `WEB DECK · COPY ONLY`, returns 15 results for "resume a session", shows the freshness
  banner and onboarding, and exposes **no run affordance**.
- Both banner tiers checked in a live browser (quiet `NOTE`, loud amber `CHECK`).

No background processes running. Ports 1420 and 8899 closed. Scratch clone deleted.

---

## 6. Live state of the machine

Measured 2026-09-21:

| product | installed | upstream | drift |
|---|---|---|---|
| omarchy | 4.0.3-1 | v4.0.4 | behind |
| claude-code | 2.1.272 | v2.1.278 | behind |
| codex | 0.154.0 | rust-v0.155.1 | behind |
| hermes | 0.21.3 | — | no public release feed |

Catalog regenerated 2026-09-21T21:42 UTC, matches installed versions (in sync).
`data/freshness.json` exists locally and is **gitignored on purpose** — it describes THIS
host, so committing it would show a clone someone else's drift as if it were their own.

**Suggested but not done:** `yay -Syu` then `python3 scripts/build_catalog.py` would clear
the banner and pick up new commands. Left alone deliberately — updating the operator's
tools is their call, not a side effect of a build.

---

## 7. Cron

Job `e4e6e817551f` — "Operator Key upstream freshness check"
- Schedule: **weekly, Mondays 09:00** (user-specified; next 2026-09-28T09:00-04:00)
- Script: `~/.hermes/profiles/portfolio/scripts/operator-key-freshness.sh`
- `no_agent=true`, `deliver=local` — silent unless there is genuinely something to report
- Repo path from `${OPERATOR_KEY_REPO:-$HOME/Work/operator-key}`, not hardcoded

**BLOCKER: the Hermes gateway is NOT running, so this job will not fire.**
Start it with `hermes gateway start`. This is a user action; it was reported, not assumed.
Also note: `deliver=local` means output is saved, not messaged into a CLI session.

---

## 8. THE NEXT SLICE — educational layer (not started)

The user's request has one part still outstanding: teaching people to use GitHub, add
skills via these portals, etc.

**Do this first, before any lesson content:** write `git` and `gh` adapters
(`scripts/adapters/git.py`, `scripts/adapters/gh.py`) so they become catalogued products.

Why this ordering is not optional: the user already agreed lessons must be **catalog-backed
so they cannot rot**. The catalog currently contains **zero git commands** — verified, and
there is now a test asserting that `"commit my changes"` returns nothing. If lessons are
written first they would cite entry IDs that do not exist, which breaks the one guarantee
that makes this product trustworthy.

Sketch, consistent with existing architecture:
1. `git`/`gh` adapters → catalog entries with real provenance and safety levels.
   `gh auth login` etc. need care: some are genuinely destructive (`git push --force`).
2. Extend `onboarding.ts` — it is already a general procedure engine, so a "first PR"
   track slots in beside the existing per-product routes.
3. Lessons reference entry IDs; a test asserts every referenced ID resolves, so a renamed
   or removed upstream command fails the build instead of silently teaching fiction.
4. Tier 3 of the freshness design (deferred, still unbuilt): catalog snapshots + diffing to
   detect when **a command the operator actually used** was renamed, removed, or changed
   safety level. This is the loud tier and needs snapshot history.

---

## 9. Open questions for the user

1. **No git remote is configured.** The repo is intended for GitHub distribution but
   `git remote -v` is empty. Creating a remote/pushing was never approved, so nothing was
   pushed. Ask before creating a GitHub repo or pushing.
2. **Gateway not running** — cron is scheduled but inert until `hermes gateway start`.
3. **Web deployment target** unknown. The static bundle works on any host; no host chosen.

---

## 10. Conventions that must survive this handoff

- Verify by running, never by asserting. Every claim in this document was re-checked.
- Report blockers honestly; never fabricate output.
- Do not commit machine-specific state.
- The app stays offline-first; network stays in the cron script.
- Commit messages explain *why*, including bugs found and how they were proven.
- Skill `version-aware-command-catalogs` holds 45 durable lessons from this work — read it
  before touching the catalog, adapters, or freshness logic.
