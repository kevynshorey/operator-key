import type { CatalogEntry, Product } from "./catalog";

/**
 * A lesson's reference to a real command.
 *
 * References are by PRODUCT + COMMAND TEXT, never by catalog entry id. Entry ids are a
 * hash of the entry's identity string, so any cosmetic change to how provenance or
 * descriptions are rendered reshuffles every id in the catalog while the command set is
 * completely unchanged. A lesson keyed on ids would break on a rebuild that changed
 * nothing a learner can see; a lesson keyed on `git commit` breaks only when `git commit`
 * genuinely stops existing, which is exactly when it SHOULD break.
 */
export interface LessonReference {
  readonly product: Product;
  /** Exact command text as the catalog spells it, e.g. "git commit". */
  readonly command: string;
}

export interface LessonStep {
  readonly id: string;
  readonly title: string;
  /** Why this step exists, in plain language a newcomer can act on. */
  readonly explain: string;
  /** Commands resolved from the catalog. Empty when none resolved on this machine. */
  readonly commands: readonly CatalogEntry[];
  /** References that did not resolve here, stated rather than hidden. */
  readonly missing: readonly LessonReference[];
  /** A specific mistake this step prevents. */
  readonly watchOut?: string;
}

export interface Lesson {
  readonly id: string;
  readonly title: string;
  readonly audience: string;
  readonly summary: string;
  /** Products a learner needs installed for this lesson to be fully usable. */
  readonly requires: readonly Product[];
  readonly steps: readonly LessonStep[];
  /** True when every referenced command resolved against this machine's catalog. */
  readonly complete: boolean;
  /** Plain statement of what is missing, or "" when nothing is. */
  readonly caveat: string;
}

interface StepTemplate {
  readonly id: string;
  readonly title: string;
  readonly explain: string;
  readonly refs: readonly LessonReference[];
  readonly watchOut?: string;
}

interface LessonTemplate {
  readonly id: string;
  readonly title: string;
  readonly audience: string;
  readonly summary: string;
  readonly requires: readonly Product[];
  readonly steps: readonly StepTemplate[];
}

const git = (command: string): LessonReference => ({ product: "git", command });
const gh = (command: string): LessonReference => ({ product: "gh", command });
const hermes = (command: string): LessonReference => ({ product: "hermes", command });

/**
 * The lesson library.
 *
 * Every command named here is checked against the catalog at build time by
 * `resolveLesson`, and a test asserts that every reference in every lesson resolves on a
 * machine where the tool is installed. That is the whole point of making lessons
 * catalog-backed: prose can drift from reality silently, but a reference that no longer
 * resolves fails the build.
 */
const LESSONS: readonly LessonTemplate[] = [
  {
    id: "git-first-save",
    title: "Save your first piece of work with Git",
    audience: "You have never used git, or you have copied commands without knowing what they do.",
    summary:
      "Git records snapshots of your work so you can go back. This lesson covers the loop that matters: look at what changed, save it deliberately, and confirm it was saved.",
    requires: ["git"],
    steps: [
      {
        id: "look-first",
        title: "Look before you do anything",
        explain:
          "`git status` tells you which files changed and which of those are staged to be saved. Running it costs nothing and changes nothing. Almost every confusing git situation is one someone walked into without looking first.",
        refs: [git("git status")],
        watchOut:
          "If status shows files you did not expect, stop and read them before staging. Staging is easy to undo; committing a secret and pushing it is not.",
      },
      {
        id: "read-the-diff",
        title: "Read exactly what changed",
        explain:
          "`git diff` shows the actual lines you added and removed. Reading your own diff before saving catches accidental edits, debug statements, and pasted credentials while they are still trivial to remove.",
        refs: [git("git diff")],
      },
      {
        id: "stage",
        title: "Stage the changes you actually want",
        explain:
          "`git add` moves changes into the staging area. This is a separate step from committing on purpose: it lets you save one coherent change rather than everything you touched today.",
        refs: [git("git add")],
        watchOut:
          "Adding everything at once is how unrelated changes end up in the same commit. Stage the files that belong to the change you are describing.",
      },
      {
        id: "commit",
        title: "Commit with a message that explains why",
        explain:
          "`git commit` writes the staged changes into history permanently. The diff already shows WHAT changed, so spend the message on WHY it changed — that is the part nobody can reconstruct later.",
        refs: [git("git commit")],
      },
      {
        id: "confirm",
        title: "Confirm it was actually saved",
        explain:
          "`git log` lists the commits that now exist. Checking is how you learn that a command succeeded rather than assuming it did, which is the habit that separates operators from people who type commands hopefully.",
        refs: [git("git log")],
      },
    ],
  },
  {
    id: "git-undo",
    title: "Get back when Git goes wrong",
    audience: "You know how to commit, and you are afraid of breaking something.",
    summary:
      "Most git fear comes from not knowing the way back. Learn these before you need them: each one undoes a different thing, and using the wrong one is how work gets lost.",
    requires: ["git"],
    steps: [
      {
        id: "unstage",
        title: "Undo a file you changed but have not committed",
        explain:
          "`git restore` puts a file back to its last committed state. This DISCARDS your edits to that file. It is the right tool when you are certain the changes were a mistake, and the wrong one if you are not.",
        refs: [git("git restore")],
        watchOut:
          "Uncommitted changes that you discard are gone; git never had a copy. When unsure, commit first — a commit you do not want is far easier to remove than work you destroyed.",
      },
      {
        id: "set-aside",
        title: "Set changes aside without losing them",
        explain:
          "`git stash` takes your uncommitted changes off the working tree and keeps them on a stack you can restore. This is the safe alternative to discarding when you need a clean tree right now but are not ready to throw work away.",
        refs: [git("git stash")],
      },
      {
        id: "undo-commit",
        title: "Undo a commit that is already shared",
        explain:
          "`git revert` creates a NEW commit that reverses an earlier one, leaving history intact. This is the correct undo for anything you have pushed, because it does not rewrite commits other people already have.",
        refs: [git("git revert")],
        watchOut:
          "`git reset` also undoes commits but by rewriting history. On a shared branch that breaks everyone else's copy. Revert is additive and safe; reset is not.",
      },
      {
        id: "find-lost",
        title: "Find work you think you lost",
        explain:
          "`git reflog` records where your branch pointed over time, including states no branch points at any more. A surprising amount of 'lost' work is recoverable from here.",
        refs: [git("git reflog")],
      },
    ],
  },
  {
    id: "github-first-pr",
    title: "Publish your work and open your first pull request",
    audience: "You can commit locally and have never shared code on GitHub.",
    summary:
      "A pull request is how you propose a change to a shared project. This lesson goes from an authenticated machine to an open PR, staying read-only until the moment you deliberately publish.",
    requires: ["git", "gh"],
    steps: [
      {
        id: "auth",
        title: "Check whether this machine is already signed in",
        explain:
          "`gh auth status` reports which account gh is acting as. Check before anything else: commands that publish will use this identity, and on a shared machine it may not be yours.",
        refs: [gh("gh auth status")],
      },
      {
        id: "sign-in",
        title: "Sign in if you need to",
        explain:
          "`gh auth login` walks through authenticating this machine. It stores a credential, so only do this on a computer you control.",
        refs: [gh("gh auth login")],
        watchOut:
          "Never paste a token into a chat, an issue, or a screen recording. If one is exposed, revoke it on GitHub immediately rather than hoping nobody noticed.",
      },
      {
        id: "branch",
        title: "Make a branch for your change",
        explain:
          "`git switch` moves you onto a separate line of work. Working on a branch means your change can be reviewed and discussed without touching the main branch everyone depends on.",
        refs: [git("git switch"), git("git branch")],
      },
      {
        id: "push",
        title: "Push the branch to GitHub",
        explain:
          "`git push` uploads your commits so GitHub can see them. This is the first moment your work leaves your machine. Everything before this was private.",
        refs: [git("git push")],
        watchOut:
          "`git push --force` overwrites what is on the remote, including other people's commits. If you think you need it, you almost always want `--force-with-lease`, which refuses when someone else has pushed work you have not seen.",
      },
      {
        id: "open-pr",
        title: "Open the pull request",
        explain:
          "`gh pr create` opens the PR from your terminal. Describe what the change does and why; reviewers read the description before the diff, and a clear one gets your work merged faster.",
        refs: [gh("gh pr create")],
      },
      {
        id: "watch-checks",
        title: "Watch the automated checks",
        explain:
          "`gh pr checks` shows whether CI passed. A red check is information, not failure — read the log and fix the cause rather than re-running it hoping for a different result.",
        refs: [gh("gh pr checks")],
      },
      {
        id: "review-own",
        title: "Review your own diff before asking anyone else to",
        explain:
          "`gh pr diff` shows the change exactly as a reviewer will see it. Reading it yourself first catches the obvious problems and is the single cheapest way to respect a reviewer's time.",
        refs: [gh("gh pr diff")],
      },
    ],
  },
  {
    id: "github-collaborate",
    title: "Work with other people's repositories",
    audience: "You want to contribute to a project you do not own.",
    summary:
      "Contributing to someone else's project has a shape: copy it, work in the open, and propose rather than impose. These commands cover that path.",
    requires: ["gh", "git"],
    steps: [
      {
        id: "find",
        title: "Find and inspect the repository first",
        explain:
          "`gh repo view` shows a repository's description and README without cloning it. Read what a project wants before writing code for it — most have contribution guidelines that will save you a rejected PR.",
        refs: [gh("gh repo view")],
      },
      {
        id: "fork",
        title: "Fork it to your own account",
        explain:
          "`gh repo fork` creates your own copy on GitHub. You push to your fork and open pull requests back to the original, which is how contribution works when you do not have write access.",
        refs: [gh("gh repo fork")],
      },
      {
        id: "clone",
        title: "Clone it to your machine",
        explain:
          "`git clone` downloads a repository and its full history into a new folder. You now have every commit locally, which is why most git operations work without a network.",
        refs: [git("git clone")],
      },
      {
        id: "issues",
        title: "Read the issues before writing code",
        explain:
          "`gh issue list` shows what the maintainers already know is wrong. Claiming an existing issue avoids duplicating work someone is already doing, and shows you read before you typed.",
        refs: [gh("gh issue list")],
      },
      {
        id: "stay-current",
        title: "Keep your copy current",
        explain:
          "`git pull` brings down commits made since you cloned. Working from a stale copy is how merge conflicts are manufactured.",
        refs: [git("git pull")],
      },
    ],
  },
  {
    id: "extend-with-skills",
    title: "Extend your agent with skills",
    audience: "You use an agent and want it to handle a recurring task properly.",
    summary:
      "A skill is reusable procedural knowledge an agent loads only when it is relevant. This lesson covers finding, inspecting, and installing skills — inspecting first, because a skill is instructions your agent will follow.",
    requires: ["hermes"],
    steps: [
      {
        id: "see-installed",
        title: "See what is already installed",
        explain:
          "`hermes skills list` shows the skills available to your agent right now. Start here: the capability you are about to add may already be present.",
        refs: [hermes("hermes skills list")],
      },
      {
        id: "search",
        title: "Search for a skill that fits",
        explain:
          "`hermes skills search` queries the registries for skills matching a task. Search by the problem you have rather than by a tool name.",
        refs: [hermes("hermes skills search")],
      },
      {
        id: "inspect",
        title: "Inspect it before installing it",
        explain:
          "`hermes skills inspect` shows a skill's contents WITHOUT installing it. A skill is instructions your agent will follow, so read it the way you would read a script before running it.",
        refs: [hermes("hermes skills inspect")],
        watchOut:
          "Installing a skill from an unknown source without reading it hands an unreviewed procedure to something that acts on your behalf. Inspect first, every time.",
      },
      {
        id: "install",
        title: "Install it",
        explain:
          "`hermes skills install` adds the skill so your agent can load it when relevant. Skills load on demand rather than occupying context permanently, which is why installing several is cheap.",
        refs: [hermes("hermes skills install")],
      },
      {
        id: "keep-current",
        title: "Keep them current",
        explain:
          "`hermes skills check` reports which installed skills have updates. Skills encode procedures against tools that keep changing, so a stale skill teaches a stale workflow.",
        refs: [hermes("hermes skills check")],
      },
    ],
  },
];

/** Build a fast lookup from `product\u0000command` (lowercased) to a catalog entry. */
function indexByCommand(entries: readonly CatalogEntry[]): Map<string, CatalogEntry> {
  const byCommand = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    const key = `${entry.product}\u0000${entry.command.trim().toLowerCase()}`;
    const held = byCommand.get(key);
    // Prefer the plain command over a flag that shares its text, and a real default over
    // a machine-local override, so a lesson teaches the canonical form.
    if (!held) {
      byCommand.set(key, entry);
      continue;
    }
    const heldRank = held.interface === "cli-flag" ? 1 : 0;
    const rank = entry.interface === "cli-flag" ? 1 : 0;
    if (rank < heldRank) byCommand.set(key, entry);
    else if (rank === heldRank && held.provenance.kind === "override" && entry.provenance.kind !== "override") {
      byCommand.set(key, entry);
    }
  }
  return byCommand;
}

/**
 * Resolve one lesson template against a catalog.
 *
 * Unresolved references are REPORTED, never dropped silently. A lesson that quietly
 * omits a step reads as complete while teaching a gap; one that says "this command is
 * not on this machine" is honest and still useful.
 */
function resolveLesson(template: LessonTemplate, byCommand: Map<string, CatalogEntry>): Lesson {
  const steps: LessonStep[] = [];
  let missingTotal = 0;

  for (const step of template.steps) {
    const commands: CatalogEntry[] = [];
    const missing: LessonReference[] = [];
    for (const ref of step.refs) {
      const entry = byCommand.get(`${ref.product}\u0000${ref.command.trim().toLowerCase()}`);
      if (entry) commands.push(entry);
      else missing.push(ref);
    }
    missingTotal += missing.length;
    steps.push({
      id: step.id,
      title: step.title,
      explain: step.explain,
      commands,
      missing,
      watchOut: step.watchOut,
    });
  }

  const absent = [...new Set(
    steps.flatMap((step) => step.missing.map((ref) => ref.product)),
  )].sort();

  return {
    id: template.id,
    title: template.title,
    audience: template.audience,
    summary: template.summary,
    requires: template.requires,
    steps,
    complete: missingTotal === 0,
    caveat: missingTotal === 0
      ? ""
      : `${missingTotal} command${missingTotal === 1 ? "" : "s"} in this lesson ${missingTotal === 1 ? "is" : "are"} not in this machine's catalog (${absent.join(", ")}). `
        + "Install the tool and rebuild the catalog to see them.",
  };
}

/** Resolve every lesson against the catalog on this machine. */
export function buildLessons(entries: readonly CatalogEntry[]): Lesson[] {
  const byCommand = indexByCommand(entries);
  return LESSONS.map((template) => resolveLesson(template, byCommand));
}

/** Lesson templates, exposed so tests can assert every reference resolves. */
export function lessonReferences(): LessonReference[] {
  return LESSONS.flatMap((lesson) => lesson.steps.flatMap((step) => step.refs));
}

/** Lesson ids in presentation order. */
export function lessonIds(): string[] {
  return LESSONS.map((lesson) => lesson.id);
}
