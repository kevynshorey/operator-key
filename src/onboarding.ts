import type { CatalogEntry, Product } from "./catalog";
import { searchCatalog, type SearchIndex } from "./search";

export interface OnboardingStep {
  readonly id: string;
  /** Short imperative title, e.g. "See where you are". */
  readonly title: string;
  /** Why a newcomer should care, in one sentence. */
  readonly why: string;
  /** What to actually do, in plain language. */
  readonly doThis: string;
  /** Catalog commands that accomplish this step, best-first. May be empty. */
  readonly commands: readonly CatalogEntry[];
  /** What the operator should understand once the step is done. */
  readonly youLearned: string;
}

export interface OnboardingPath {
  readonly product: Product;
  readonly title: string;
  readonly intro: string;
  readonly steps: readonly OnboardingStep[];
}

interface StepTemplate {
  readonly id: string;
  readonly title: string;
  readonly why: string;
  readonly doThis: string;
  readonly youLearned: string;
  /** Search probes, tried in order, to find real commands for this step. */
  readonly probes: readonly string[];
  /** Task groups that are acceptable for this step, when a probe is ambiguous. */
  readonly taskGroups?: readonly string[];
  /** Products this step is true for. Omitted means every product. */
  readonly appliesTo?: readonly Product[];
  /** Concepts that make a command a GOOD fit for this step. */
  readonly keywords: readonly string[];
  /** Concepts that disqualify a candidate, even when search ranked it highly. */
  readonly avoid?: readonly string[];
}

/**
 * The route deliberately starts read-only and ends with recovery. Every step must be
 * something a newcomer can do on their own machine without breaking anything: the goal is
 * confidence, not coverage.
 *
 * `appliesTo` exists because these products are not the same kind of thing. Omarchy is a
 * desktop: it has no "session" to start and nothing to verify. Emitting empty steps for it
 * would teach a beginner that they had missed something. Each product gets the steps that
 * are true for it.
 */
const STEP_TEMPLATES: readonly StepTemplate[] = [
  {
    id: "orient",
    keywords: ["status", "state", "info", "doctor", "diagnose", "health", "version", "show", "list", "monitor", "overview"],
    avoid: ["quit", "exit", "kill", "delete", "remove", "logout"],
    title: "See where you are",
    why: "Before changing anything, learn how to ask the tool what state it is in. This is the habit that prevents most beginner mistakes.",
    doThis: "Run a status or help command and read every line of the output, even the parts you do not understand yet.",
    youLearned: "Tools will tell you their own state if you ask. Checking first is free; guessing is not.",
    probes: ["status", "show status", "current state", "doctor", "diagnose"],
    // "debug-and-recover" is included because a doctor/health command is orientation, not
    // repair: it is the safest possible first thing a newcomer can run.
    taskGroups: ["help-and-reference", "sessions-and-navigation", "system-and-hardware", "debug-and-recover"],
  },
  {
    id: "find-help",
    keywords: ["help", "--help", "-h", "docs", "documentation", "manual", "reference", "commands", "?"],
    avoid: ["quit", "exit", "touchpad", "power", "reboot", "shutdown", "logout", "kill", "newline", "prompt", "insert", "paste", "clipboard"],
    title: "Get help without leaving the terminal",
    why: "The fastest operators are not the ones who memorised everything — they are the ones who know how to look things up in place.",
    doThis: "Open the built-in help and skim the list of available commands. You are not memorising it, just learning the shape of it.",
    youLearned: "Every serious tool ships its own manual. Reaching for it is a skill, not an admission of ignorance.",
    probes: ["help", "list commands", "documentation", "reference"],
    taskGroups: ["help-and-reference"],
  },
  {
    id: "start-work",
    keywords: ["new", "chat", "session", "conversation", "resume", "continue"],
    // "cursor" and "line" exclude editing hotkeys like Ctrl+A ("move cursor to start of
    // line"), which a newcomer would badly misread as "start a session".
    avoid: ["delete", "remove", "kill", "quit", "exit", "cursor", "line", "scroll"],
    title: "Start a session and do one real thing",
    why: "A session is the unit of work. Understanding where your conversation lives makes everything else make sense.",
    doThis: "Start a session, ask for something small and specific, and watch how the tool responds.",
    youLearned: "Work happens inside a session that has its own history and context, which you can leave and come back to.",
    probes: ["new session", "start session", "resume session", "new chat", "new conversation"],
    // Catalogs file session commands inconsistently: "/resume" lands in parallel-agents
    // and "/clear" in context-and-memory, so the whitelist has to span all of them.
    // Without any whitelist, bare editing hotkeys score their way in.
    taskGroups: [
      "sessions-and-navigation",
      "context-and-memory",
      "help-and-reference",
      "parallel-agents",
    ],
    appliesTo: ["hermes", "claude-code", "codex"],
  },
  {
    id: "inspect-change",
    keywords: ["diff", "review", "changes", "show", "status"],
    avoid: ["apply", "commit", "push", "merge", "discard", "revert", "delete"],
    title: "Look at a change before accepting it",
    why: "Reviewing a diff is the single highest-value habit in software work. It is how you stay responsible for code you did not type.",
    doThis: "Ask to see the changes as a diff. Read what was added and removed before you accept anything.",
    youLearned: "You can always inspect before you commit. An agent proposing a change is not the same as the change being right.",
    probes: ["diff", "review changes", "show changes"],
    taskGroups: ["review-and-verify", "development"],
    appliesTo: ["hermes", "claude-code", "codex"],
  },
  {
    id: "verify",
    keywords: ["verify", "check", "test", "review", "validate", "lint"],
    avoid: ["skip", "force", "dangerously", "bypass", "delete"],
    title: "Check that it actually worked",
    why: "Finished is not the same as correct. Verification is what separates a working change from one that merely ran.",
    doThis: "Run the verification or check command and read the result rather than assuming success.",
    youLearned: "Confirm outcomes from the tool's own output. 'It ran without an error' is not proof that it did what you wanted.",
    probes: ["verify", "check", "test"],
    taskGroups: ["review-and-verify", "development"],
    appliesTo: ["hermes", "claude-code", "codex"],
  },
  {
    id: "navigate",
    keywords: ["workspace", "window", "focus", "switch", "move", "tab", "next", "previous"],
    avoid: ["kill", "close", "quit", "power", "reboot", "shutdown", "delete"],
    title: "Move around without the mouse",
    why: "On a keyboard-driven desktop, window and workspace movement is the whole interface. It is the first thing to build muscle memory for.",
    doThis: "Switch between windows and workspaces a few times until the motion stops requiring thought.",
    youLearned: "The desktop is driven from the keyboard. Once movement is automatic, everything else gets faster.",
    probes: ["switch window", "workspace", "focus window"],
    taskGroups: ["sessions-and-navigation"],
    appliesTo: ["omarchy"],
  },
  {
    id: "launch",
    keywords: ["launch", "open", "terminal", "menu", "apps", "application"],
    avoid: ["power", "reboot", "shutdown", "kill", "lock", "logout", "theme", "capture"],
    title: "Open what you need",
    why: "Launching applications and a terminal from the keyboard removes the last reason to reach for a mouse.",
    doThis: "Open a terminal and an application from the keyboard, then close them again.",
    youLearned: "Everything you open regularly has a key for it. Learning three of them changes how the machine feels.",
    probes: ["launch", "open terminal", "terminal", "menu", "apps"],
    // Omarchy files its terminal hotkey under "development"; the terminal is the single
    // most important thing a newcomer needs to be able to open, so it must be reachable.
    taskGroups: [
      "capture-and-input",
      "sessions-and-navigation",
      "system-and-hardware",
      "help-and-reference",
      "development",
    ],
    appliesTo: ["omarchy"],
  },
  {
    id: "recover",
    keywords: ["undo", "rewind", "restore", "revert", "back", "escape", "interrupt", "cancel", "stop"],
    avoid: ["delete", "purge", "wipe", "force", "hard"],
    title: "Learn the way back",
    why: "Knowing how to undo removes the fear that makes beginners hesitate. Learn this before you need it, not during a bad moment.",
    doThis: "Find the undo, rewind or restore command for your tool and read what exactly it reverses.",
    youLearned: "Almost everything is reversible if you know the recovery path in advance. Find it before you take a risk, not after.",
    probes: ["undo", "rewind", "restore", "revert", "interrupt", "cancel", "stop"],
    // Some tools have no undo at all; for those, stopping runaway work is the way back.
    taskGroups: ["debug-and-recover", "sessions-and-navigation", "review-and-verify", "parallel-agents"],
  },
];

const PRODUCT_TITLES: Record<Product, string> = {
  omarchy: "First 10 minutes with Omarchy",
  hermes: "First 10 minutes with Hermes",
  "claude-code": "First 10 minutes with Claude Code",
  codex: "First 10 minutes with Codex",
};

const PRODUCT_INTROS: Record<Product, string> = {
  omarchy: "Omarchy is the desktop itself. These steps teach you to move around it with the keyboard instead of hunting for windows.",
  hermes: "Hermes runs agents and sessions from your terminal. These steps teach you the loop: start work, inspect it, verify it, undo it.",
  "claude-code": "Claude Code works inside a running session using slash commands. These steps teach you to drive it deliberately rather than hopefully.",
  codex: "Codex works on your code from the terminal. These steps teach you to review and verify what it produces before you keep it.",
};

/**
 * Pick commands for a step from the real catalog. Safety is the hard constraint: an
 * onboarding route must never hand a newcomer a destructive or red command, even if it
 * would be the best keyword match.
 */
/**
 * Score how well a candidate actually fits a step, beyond the search engine's lexical hit.
 * Search alone returns things like "/quit" for a help probe because the word appears in
 * its description; a teaching route must not present that as the lesson.
 */
/** Whole-word test, so "start of current line" does not match the concept "start". */
function mentions(haystack: string, keyword: string): boolean {
  if (!/^[a-z0-9]+$/i.test(keyword)) return haystack.includes(keyword);
  return new RegExp(`\\b${keyword}\\b`, "i").test(haystack);
}

function fitScore(entry: CatalogEntry, template: StepTemplate): number {
  const command = entry.command.toLowerCase();
  // An alias IS a command name ("/clear" is aliased "/new"), so it belongs to the name
  // surface, not to prose.
  const names = `${command} ${entry.aliases.join(" ")}`.toLowerCase();
  const prose = `${entry.description} ${entry.category}`.toLowerCase();
  // A hotkey's text is a key combination ("SUPER + TAB"), so it can never contain an
  // English keyword. For those entries the description IS the semantic surface; judging
  // them by their command text would structurally delete every desktop route.
  const nameCarriesMeaning = entry.interface !== "hotkey";
  // Whichever surface we trust for matching, we must also trust for disqualifying —
  // otherwise a hotkey matches on prose but can never be vetoed by it.
  const authoritative = nameCarriesMeaning ? names : `${names} ${prose}`;
  let score = 0;
  let strongHit = false;

  for (const keyword of template.keywords) {
    if (nameCarriesMeaning && mentions(names, keyword)) {
      score += 100;
      strongHit = true;
    } else if (mentions(prose, keyword)) {
      // Hotkeys can only ever match on prose, so that has to count as real evidence —
      // but below a named command, so "/new" still outranks "Ctrl+A" for the same lesson.
      score += nameCarriesMeaning ? 10 : 55;
      if (!nameCarriesMeaning) strongHit = true;
    }
  }
  for (const keyword of template.avoid ?? []) {
    // Disqualify on the authoritative surface strongly, elsewhere weakly. Claude Code's
    // "/clear" is described as "Start a new conversation with empty context" — prose that
    // mentions clearing while the command genuinely is how you start fresh. A blanket
    // prose veto would delete the correct answer.
    if (mentions(authoritative, keyword)) score -= 250;
    else if (mentions(prose, keyword)) score -= 30;
  }
  if (template.taskGroups?.includes(entry.task_group)) score += 40;

  // Weak evidence on its own: "/btw" mentions help in its prose but is not a help command.
  if (!strongHit) score -= 200;

  // A single-character command ("f", "u") is a power-user accelerator. It may be correct,
  // but it is never the clearest way to TEACH a concept, so it must not lead a step.
  if (command.replace(/[^a-z0-9]/gi, "").length <= 1) score -= 90;

  // Mild tie-breaker toward the plainest form ("/help" over "? on empty input").
  score -= Math.min(20, command.length / 4);
  return score;
}

/** Gather scored, safety-filtered candidates for a step. Ranking happens in the caller. */
function candidatesForStep(
  index: SearchIndex,
  template: StepTemplate,
  product: Product,
): Array<{ entry: CatalogEntry; score: number }> {
  const candidates = new Map<string, CatalogEntry>();

  for (const probe of template.probes) {
    for (const result of searchCatalog(index, probe, { product }, 20)) {
      const entry = result.entry;
      if (!entry.available) continue;
      // Hard safety floor for a teaching route.
      if (entry.destructive || entry.safety_level === "red") continue;
      if (template.taskGroups && !template.taskGroups.includes(entry.task_group)) continue;
      candidates.set(entry.id, entry);
    }
  }

  return [...candidates.values()]
    .map((entry) => ({ entry, score: fitScore(entry, template) }))
    // Require positive evidence: a candidate that matches nothing the step is about is
    // noise, and noise in an onboarding route is worse than a shorter route.
    .filter((item) => item.score > 0);
}

/**
 * Build a guided route through the catalog for one product. Steps that do not apply to a
 * product are omitted rather than shown empty: a desktop has no session to start, and an
 * empty step would read as something the newcomer failed to find.
 */
export function buildOnboardingPath(index: SearchIndex, product: Product): OnboardingPath {
  const templates = STEP_TEMPLATES.filter(
    (template) => !template.appliesTo || template.appliesTo.includes(product),
  );

  // Assign each command to the step it fits BEST, not to whichever step happens to run
  // first. Without this, "find-help" claims every menu hotkey and the "launch" step is
  // left empty even though the catalog clearly contains a terminal launcher.
  const claims = new Map<string, { stepId: string; score: number }>();
  const pools = new Map<string, Array<{ entry: CatalogEntry; score: number }>>();

  for (const template of templates) {
    const pool = candidatesForStep(index, template, product);
    pools.set(template.id, pool);
    for (const { entry, score } of pool) {
      const held = claims.get(entry.id);
      if (!held || score > held.score) claims.set(entry.id, { stepId: template.id, score });
    }
  }

  const steps = templates
    .map((template): OnboardingStep => {
      const pool = (pools.get(template.id) ?? [])
        .filter(({ entry }) => claims.get(entry.id)?.stepId === template.id)
        .sort((left, right) => right.score - left.score
          || left.entry.id.localeCompare(right.entry.id));

      // Several catalog rows can share one display command (e.g. "-h / --help" documented
      // per subcommand). Showing the same text three times teaches nothing.
      const seenText = new Set<string>();
      const commands: CatalogEntry[] = [];
      for (const { entry } of pool) {
        if (commands.length >= 3) break;
        const textKey = entry.command.trim().toLowerCase();
        if (seenText.has(textKey)) continue;
        seenText.add(textKey);
        commands.push(entry);
      }

      return {
        id: template.id,
        title: template.title,
        why: template.why,
        doThis: template.doThis,
        youLearned: template.youLearned,
        commands,
      };
    })
    // A step with nothing to click is not a lesson, it is a dead end that reads as a
    // failure to find something. Drop it rather than render an empty panel.
    .filter((step) => step.commands.length > 0);

  return {
    product,
    title: PRODUCT_TITLES[product],
    intro: PRODUCT_INTROS[product],
    steps,
  };
}
