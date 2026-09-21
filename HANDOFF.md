# Operator Key — Session Handoff

Written: 2026-09-21 (AST)
Repo: `~/Work/operator-key`
Branch: `main` — HEAD `3a81199`
Working tree: CLEAN (verified `git status --porcelain` empty)
Remote: `https://github.com/kevynshorey/operator-key` — **PUBLIC**, local and origin in sync

---

## 1. What this product is

Operator Key is a local command instrument: a React + Tauri desktop app that indexes
every command, flag, slash-command and keybinding for six tools installed on the machine
(omarchy, hermes, claude-code, codex, git, gh) and lets an operator find them by intent
("undo my last commit") rather than by memorising syntax.

The governing principle across every slice is **honesty over helpfulness**. The app is
worth using only because what it shows is true of the machine it runs on. Every design
decision below follows from that: it never invents an answer, never implies currency it
has not verified, never executes anything it has not been explicitly asked to, and says
"I cannot tell" rather than guessing. A confident wrong answer is the failure mode that
destroys the product.

Current catalog: **2,174 entries**
(omarchy 228, hermes 706, claude-code 282, codex 87, git 549, gh 322).

---

## 2. Original objective (user's words, verbatim)

> "this product must always be up to date with regular checks from the websites that make
> the tools we are using and also any changes in the repos etc, i think some kind of
> eductional aspect to this would also be a gret addition, how to use places like git hub
> and how to add skills etc using these portals brainsrorm how this could be implemented"

Then, as constraints:

> "cron should be weekly also remember this app will be installed on other machines as a
> github repo download so ensure all functions will be set that way also this should be in
> the future a web app if it becoms popular"

All three parts are now complete:
1. **Freshness** — DONE (`892f273`, hardened in `b09f520`, RC false alarm fixed in `3a81199`)
2. **Portability + web-app readiness** — DONE (`b09f520`, re-proven by clone at `3a81199`)
3. **Educational layer, incl. git/GitHub** — DONE (`6aff619`)

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
| `src/lessons.ts` | Catalog-backed workflow lessons (git, GitHub, skills) |
| `src/freshness.ts` | How far to trust the catalog right now |
| `src/catalog.ts` | Catalog load/parse/search index |
| `src/runtime.ts` | `"native"` vs `"web"` detection |

**Suggest and explain, never auto-run.** The audience is people being handed the tool,
not the author. Teaching outranks convenience everywhere.

**False alarms are the enemy.** A safety flag that fires wrongly trains operators to
ignore real warnings. Same logic governs the freshness banner and the update checker.
No keyword matching without an intent cross-check.

**The app never touches the network.** All network I/O is isolated in
`scripts/check_updates.py`, run from cron only. Network content can NEVER mutate
`catalog.json`; it writes advisory `data/freshness.json` only. A test greps the checker
source to prove the catalog path is never written — a comment is not a boundary.

**The catalog is built from local binaries**, which is the only reason it can be trusted.

**Lessons are catalog-backed and keyed by command text, not entry ID.** Entry IDs hash
their provenance string, so changing how provenance renders reshuffles every ID while the
command set is unchanged. A lesson keyed on IDs would break on a rebuild that changed
nothing a learner can see.

---

## 4. Completed work (each verified, not assumed)

### `b478834` — apprentice learning surface
`predict.ts`, `teach.ts`, `followups.ts` + UI wiring.

### `1779edb` — guided onboarding + reverse lookup
`onboarding.ts`, `explain.ts`. Reverse lookup uses the same rules as catalog entries, so
a pasted command is explained with identical authority.

### `892f273` — freshness checking and honest staleness display
- `scripts/check_updates.py`: installed versions via `pacman -Q` and `--version`; upstream
  via GitHub releases API; conditional GET (ETag/Last-Modified) on docs so unchanged pages
  cost a 304 with no body; offline-safe.
- `src/freshness.ts` + banner in `App.tsx`.
- Fixed two real upstream bugs found while probing: a Codex docs **308-redirect** that made
  the catalog cite provenance it no longer read, and an Omarchy repo move
  (`basecamp/omarchy` → `omacom/omarchy`).

### `b09f520` — honesty on machines that did not build the catalog
Three real bugs, all found by actually cloning the repo rather than reasoning about it:
- **Username leak**: 105 entries embedded an absolute home path in provenance. Now rendered
  `~/...` via `portable_path()`. A test fails the build if `/home/` or `/Users/` reappears
  anywhere in the catalog JSON.
- **Absent tools reported as "out of date"**: `installed_here` is now its own state —
  stated once, excluded from all staleness/drift verdicts, and costs no network requests.
- **A search test passing by accident**: `"commit my changes"` matched one hermes flag only
  because its description was truncated mid-sentence. (Superseded by `6aff619`: git
  commands now exist, so that query has a real answer.)

### `6aff619` — git + gh adapters and the educational layer
Lessons had to wait on adapters: the catalog contained zero git commands, so lessons
written first would have cited commands that do not exist.

Four bugs found by running the extraction rather than reasoning about it:
- **`git <cmd> -h` exits 129.** The shared runner used `check=True` and silently returned
  `""`, so an adapter built on it would have catalogued zero flags while the build stayed
  green. Added `run_lenient()`.
- **`clean()` strips `<...>` as an HTML tag**, turning
  `--force-with-lease[=<refname>:<expect>]` into `--force-with-lease[=:]`.
- **`git help -a` lists aliases in its own section** with no provenance and no target;
  cataloguing them there produced duplicates that discarded the override provenance
  `parse_aliases` attaches.
- **gh prints `-c, --clone` where git prints the long form alone.** One concept rendering
  two ways inside one catalog splits search between the spellings.

Plus a pre-existing bug this slice exposed:
- **`"skills"` contains `"kill"`.** Substring matching flagged **30 entries** red and
  destructive, including read-only `hermes skills list` and `/skills`.
  `--show-forced-updates` matched `"force"` the same way. Both now match on word
  boundaries. A badge that fires on `hermes skills list` is one operators learn to ignore
  before the day it fires on `git push --force`.

Safety and task group are now **stated by the adapters, not inferred**: the keyword
classifier rates `git reset`, `git rebase`, `git push` and `gh pr merge` green, and files
`git commit` ("Record changes...") under capture-and-input. `git reflog` is deliberately
NOT red — bare `git reflog` is `git reflog show`, read-only, and the best tool for
recovering lost commits; only its expire/delete/drop subcommands destroy anything.

Onboarding pedagogy was fixed by reading generated routes as a beginner (skill rule 19):
structural tests were green while the git route opened with `git diagnose` (produces a
bug-report zip), offered `git fetch --write-fetch-head` as "find help", and ranked obscure
flags above plain commands.

### `2d3cf7f` — MIT license and a clone-first note
Without a LICENSE nobody legally has permission to use or contribute. README now says the
shipped catalog was built on another machine and should be rebuilt.

### `3a81199` — stop reporting release candidates as updates
Found by running the real weekly cron script rather than trusting its tests. It reported
`git: 2.55.0 -> v2.56.0-rc1`: an operator on current stable was told they were behind
software that is not released yet. Pre-release tags are now filtered, with a fallback when
a project has never tagged anything stable. The pattern is anchored so `rust-v0.155.1`
(codex's normal stable spelling) is not mistaken for a pre-release — dropping that feed
would silently remove the only release source that product has.

---

## 5. Verification status (re-run fresh at handoff, not copied from memory)

```
TypeScript:  259 tests passing, 20 test files   (npm test)
Python:      160 tests passing                  (python3 -m unittest discover -s tests)
Typecheck:   0 errors                           (npm run typecheck)
Lint:        clean, --max-warnings 0            (npm run lint)
Build:       succeeds                           (npm run build)
```

Verified by real execution, not simulation:
- Cloned the **public GitHub repo** to a scratch dir and ran its suite there: 160 Python
  tests pass, and the RC fix is present in the published tree.
- Simulated a bare machine by patching the version probe to raise `FileNotFoundError`:
  git and gh report `not-installed` with `installed_here: false`, not false `STALE`.
- Adapters on a bare machine return `unknown` and 0 entries rather than crashing.
- Catalog rebuild is deterministic: two consecutive builds are byte-identical apart from
  the `generated_at` provenance timestamp.
- No `/home/` or `/Users/` anywhere in the catalog JSON.
- Ran the real cron script end-to-end; it now tracks git and gh, and after `3a81199` git
  correctly drops off the "behind upstream" list while the four genuinely-behind tools
  stay on it.
- Read the lessons panel in a real browser at 2,174 entries. That is where the last defect
  surfaced: lesson prose printed literal backticks, teaching newcomers that the
  punctuation was part of the command. Now rendered as code, with a regression test.
- Searched "undo my last commit" in the browser: returns `git revert` as the top result.
  The previous handoff recorded that exact query returning zero results.

No background processes running. Ports 1420 and 8899 closed. Scratch clones deleted.

---

## 6. Live state of the machine

Measured 2026-09-21:

| product | installed | upstream | drift |
|---|---|---|---|
| omarchy | 4.0.3-1 | v4.0.4 | behind |
| claude-code | 2.1.272 | v2.1.278 | behind |
| codex | 0.154.0 | rust-v0.155.1 | behind |
| gh | 2.100.0 | v2.101.0 | behind |
| git | 2.55.0 | v2.55.0 | current (v2.56.0-rc1 correctly ignored) |
| hermes | 0.21.3 | — | no public release feed |

Catalog matches installed versions (in sync). `data/freshness.json` exists locally and is
**gitignored on purpose** — it describes THIS host, so committing it would show a clone
someone else's drift as if it were their own.

**Suggested but not done:** `yay -Syu` then `python3 scripts/build_catalog.py` would clear
the banner and pick up new commands. Left alone deliberately — updating the operator's
tools is their call, not a side effect of a build.

---

## 7. Cron

Job `e4e6e817551f` — "Operator Key upstream freshness check"
- Schedule: **weekly, Mondays 09:00** (user-specified; next 2026-09-28T09:00-04:00)
- Script: `~/.hermes/profiles/portfolio/scripts/operator-key-freshness.sh`
- `no_agent=true`, `deliver=telegram` — silent unless there is genuinely something to report
- Repo path from `${OPERATOR_KEY_REPO:-$HOME/Work/operator-key}`, not hardcoded

**Gateway: RESOLVED** (was the blocker in the previous handoff). Installed as a user
systemd service (`hermes-gateway-portfolio.service`), enabled at boot with linger so it
survives logout. Verified `active (running)`; `cronjob list` reports `gateway_running:
true` and the job as `enabled`/`scheduled`. The script was run manually end-to-end and
works.

Delivery is **Telegram** (user-chosen). `no_agent=true` means stdout is delivered verbatim
and EMPTY stdout sends nothing at all — the watchdog pattern, so a week where every tool is
current is a silent week rather than a "nothing to report" ping. A non-zero exit or timeout
still raises an error alert, so genuine breakage is never silent.

**Known operational gotcha — Telegram bot-token conflict.** Telegram permits exactly ONE
poller per bot token. A long-running interactive Hermes CLI session holds that token, so
while one is open the gateway loses the race and logs
`Conflict: terminated by other getUpdates request`, ending with
`Gateway started with no connected platforms`. It retries about every 60s and connects on
its own once the CLI session exits; no manual restart is needed.

**A cron run can report `last_status: ok` while nothing was delivered.** That field reflects
the SCRIPT's exit code, not the send. Verified on 2026-09-21: the job ran, produced correct
drift output, and saved it to
`~/.hermes/profiles/portfolio/cron/output/e4e6e817551f/` — but no message was sent, because
no platform was connected. To confirm real delivery, check the gateway log for
`[Telegram] Connected to Telegram (polling mode)` WITHOUT a following conflict, rather than
trusting the cron status field.

---

## 8. Possible next slices (none started)

1. **Tier 3 freshness** (deferred, still unbuilt): catalog snapshots + diffing to detect
   when **a command the operator actually used** was renamed, removed, or changed safety
   level. This is the loud tier and needs snapshot history.
2. **More lessons.** The engine takes a template and resolves it against the catalog, so
   adding a lesson is data, not code. Candidates: resolving merge conflicts, rebase vs
   merge, reviewing someone else's PR.
3. **Web deployment.** The static bundle works on any host; no host chosen.

---

## 9. Open questions for the user

1. **Web deployment target** unknown. The static bundle is ready; no host chosen.

---

## 10. Conventions that must survive this handoff

- Verify by running, never by asserting. Every claim in this document was re-checked.
- Report blockers honestly; never fabricate output.
- Do not commit machine-specific state.
- The app stays offline-first; network stays in the cron script.
- Commit messages explain *why*, including bugs found and how they were proven.
- Print generated teaching content and read it as a beginner before trusting green tests.
  Structural assertions prove shape, never pedagogy.
- Skill `version-aware-command-catalogs` holds the durable lessons from this work — read it
  before touching the catalog, adapters, lessons, or freshness logic.
