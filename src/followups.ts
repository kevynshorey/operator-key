import type { CatalogEntry, Product } from "./catalog";
import { searchCatalog, type SearchIndex } from "./search";

export type FollowUpClass = "verify" | "quality" | "security" | "iterate" | "recover";
export type FollowUpPriority = "required" | "recommended" | "optional";

export interface FollowUpAction {
  entry: CatalogEntry;
  reason: string;
}

export interface FollowUp {
  kind: FollowUpClass;
  title: string;
  /** The operator's real question, in their words rather than the catalog's. */
  question: string;
  priority: FollowUpPriority;
  /** Why this was raised for THIS entry, sourced from that entry's own signals. */
  rationale: string;
  actions: FollowUpAction[];
}

const PRIORITY_ORDER: Record<FollowUpPriority, number> = { required: 0, recommended: 1, optional: 2 };
const CLASS_ORDER: Record<FollowUpClass, number> = {
  recover: 0, security: 1, quality: 2, verify: 3, iterate: 4,
};

const TITLES: Record<FollowUpClass, string> = {
  verify: "Confirm it worked",
  quality: "Run code checks",
  security: "Security review",
  iterate: "Repeat or parallelise",
  recover: "Recovery path",
};

const QUESTIONS: Record<FollowUpClass, string> = {
  verify: "How do I know this actually did what I wanted?",
  quality: "Do I need to run checks before this counts as done?",
  security: "Could this expose something it should not?",
  iterate: "What if I need to do this repeatedly or in parallel?",
  recover: "What do I do if this goes wrong?",
};

/** Search probes per class, most specific first. Every result is a real catalog entry. */
const PROBES: Record<FollowUpClass, readonly string[]> = {
  verify: ["status", "doctor", "list", "diff", "log"],
  quality: ["test", "lint", "review", "typecheck", "check"],
  security: ["audit", "permissions", "approve", "secret", "auth"],
  iterate: ["background", "parallel", "worktree", "delegate", "queue"],
  recover: ["undo", "rollback", "restore", "revert", "stop"],
};

const SECURITY_TOKENS = [
  "auth", "token", "secret", "key", "credential", "login", "password", "permission",
  "sudo", "chmod", "chown", "ssh", "env", "approve", "yolo", "privilege",
];
const QUALITY_TOKENS = [
  "commit", "push", "merge", "deploy", "release", "publish", "build", "install", "pr",
  "pull-request", "patch", "write", "edit", "refactor",
];
const ITERATE_TOKENS = [
  "agent", "session", "spawn", "background", "delegate", "worktree", "batch", "cron", "job",
];
/** Quality tokens that mean work leaves the operator's machine and reaches others. */
const PUBLISH_TOKENS = ["commit", "push", "merge", "deploy", "release", "publish", "pr"];

/**
 * Two vocabularies per entry, because a command that MENTIONS a concept is not a command
 * that DOES it. "/code-review" describes posting to a PR, but it is a green read-only
 * review command — treating its prose as intent produced false "publishes work" warnings.
 */
function tokensOf(entry: CatalogEntry): Set<string> {
  const source = `${entry.command} ${entry.description} ${entry.category} ${entry.task_group} ${entry.aliases.join(" ")}`;
  return new Set(source.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/** What the command IS — its own name, aliases and classification. Excludes prose. */
function identityTokensOf(entry: CatalogEntry): Set<string> {
  const source = `${entry.command} ${entry.category} ${entry.task_group} ${entry.aliases.join(" ")}`;
  return new Set(source.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function matches(tokens: ReadonlySet<string>, vocabulary: readonly string[]): string[] {
  return vocabulary.filter((word) => tokens.has(word));
}

function resolveActions(
  index: SearchIndex,
  probes: readonly string[],
  product: Product,
  excludeId: string,
  limit: number,
): FollowUpAction[] {
  const actions: FollowUpAction[] = [];
  const seen = new Set<string>([excludeId]);

  // Same product first: an operator mid-task should not be sent to another tool.
  for (const scope of [product, undefined] as const) {
    for (const probe of probes) {
      if (actions.length >= limit) return actions;
      for (const result of searchCatalog(index, probe, scope ? { product: scope } : {}, 6)) {
        if (actions.length >= limit) return actions;
        if (seen.has(result.entry.id) || !result.entry.available) continue;
        seen.add(result.entry.id);
        actions.push({ entry: result.entry, reason: `Matches “${probe}” in the local catalog.` });
      }
    }
  }
  return actions;
}

interface Signal {
  kind: FollowUpClass;
  priority: FollowUpPriority;
  rationale: string;
}

/**
 * Read the entry's own signals and decide which follow-up questions are warranted.
 * Rationale text is built from what was actually detected so the operator learns the
 * rule, not just the recommendation.
 */
function detectSignals(entry: CatalogEntry): Signal[] {
  const tokens = tokensOf(entry);
  const identityTokens = identityTokensOf(entry);
  const signals: Signal[] = [];
  const isWriteSurface = entry.interface === "shell-command" || entry.interface === "cli-flag";

  if (entry.destructive || entry.safety_level === "red") {
    signals.push({
      kind: "recover",
      priority: "required",
      rationale: `This entry is marked ${entry.safety_level} safety${entry.destructive ? " and destructive" : ""}. Know the way back before you run it.`,
    });
  } else if (entry.safety_level === "amber") {
    signals.push({
      kind: "recover",
      priority: "recommended",
      rationale: "Amber safety means this changes state. A known recovery path costs nothing until you need it.",
    });
  }

  const securityHits = matches(tokens, SECURITY_TOKENS);
  if (securityHits.length > 0) {
    // Same mention-vs-identity rule as quality: a green command whose NAME says nothing
    // about credentials is only worth an optional look, however its prose reads.
    const securityIdentityHits = matches(identityTokens, SECURITY_TOKENS);
    const handlesSecurity = securityIdentityHits.length > 0 || entry.safety_level !== "green";
    const evidence = (handlesSecurity && securityIdentityHits.length > 0 ? securityIdentityHits : securityHits).slice(0, 3).join(", ");
    signals.push({
      kind: "security",
      priority: !handlesSecurity ? "optional" : entry.safety_level === "green" ? "recommended" : "required",
      rationale: handlesSecurity
        ? `Touches ${evidence}. Anything handling credentials or permissions deserves a deliberate look.`
        : `Mentions ${evidence}, but is marked green and read-only. Worth understanding, not gating.`,
    });
  } else if (entry.destructive) {
    signals.push({
      kind: "security",
      priority: "recommended",
      rationale: "Destructive actions are worth a security pass even when no credential is named.",
    });
  }

  const qualityHits = matches(tokens, QUALITY_TOKENS);
  if (qualityHits.length > 0) {
    // "Publishes" is only claimed when the command's own identity says so AND it is
    // allowed to change state. A green, read-only command that merely discusses pull
    // requests must never be escalated to a required pre-publish check.
    const identityHits = matches(identityTokens, QUALITY_TOKENS);
    const publishes = entry.safety_level !== "green"
      && identityHits.some((hit) => PUBLISH_TOKENS.includes(hit));
    const evidence = (publishes ? identityHits : qualityHits).slice(0, 3).join(", ");
    signals.push({
      kind: "quality",
      priority: publishes ? "required" : "recommended",
      rationale: publishes
        ? `This publishes work (${evidence}). Checks belong before it, not after.`
        : `This relates to changing code or configuration (${evidence}). Run the checks while the change is still fresh.`,
    });
  } else if (entry.task_group === "development" && isWriteSurface) {
    signals.push({
      kind: "quality",
      priority: "recommended",
      rationale: "A development command that writes state should be followed by the project's checks.",
    });
  }

  signals.push({
    kind: "verify",
    priority: entry.safety_level === "green" ? "optional" : "recommended",
    rationale: entry.safety_level === "green"
      ? "Low risk, but confirming the result is how you learn what this command actually changes."
      : "This changes state. Confirm the new state rather than assuming it.",
  });

  const iterateHits = matches(tokens, ITERATE_TOKENS);
  if (iterateHits.length > 0) {
    signals.push({
      kind: "iterate",
      priority: "optional",
      rationale: `Relates to ${iterateHits.slice(0, 3).join(", ")}. Work like this is usually repeated, so it is worth knowing the parallel and background forms.`,
    });
  }

  return signals;
}

/**
 * Build the follow-up guidance for a selected entry.
 *
 * Every suggested action is resolved through the local catalog index, so the engine can
 * recommend a direction but can never author command text. When the catalog holds no
 * command for a warranted class, the question is still surfaced with an honest note.
 */
export function buildFollowUps(
  index: SearchIndex,
  entry: CatalogEntry,
  limit = 5,
  actionsPerFollowUp = 3,
): FollowUp[] {
  const bestByClass = new Map<FollowUpClass, Signal>();
  for (const signal of detectSignals(entry)) {
    const existing = bestByClass.get(signal.kind);
    if (!existing || PRIORITY_ORDER[signal.priority] < PRIORITY_ORDER[existing.priority]) {
      bestByClass.set(signal.kind, signal);
    }
  }

  return [...bestByClass.values()]
    .sort((left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
      || CLASS_ORDER[left.kind] - CLASS_ORDER[right.kind])
    .slice(0, Math.max(0, limit))
    .map((signal) => ({
      kind: signal.kind,
      title: TITLES[signal.kind],
      question: QUESTIONS[signal.kind],
      priority: signal.priority,
      rationale: signal.rationale,
      actions: resolveActions(index, PROBES[signal.kind], entry.product, entry.id, actionsPerFollowUp),
    }));
}
