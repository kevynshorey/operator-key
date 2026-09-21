import type { CatalogEntry, SafetyLevel } from "./catalog";
import { searchCatalog, type SearchIndex } from "./search";
import {
  classifyShellToken,
  explainShellToken,
  type CommandToken,
  type TokenRole,
} from "./teach";

export type ExplainConfidence = "exact" | "close" | "unknown";

export interface ExplainRisk {
  /** Short label shown as the warning heading. */
  readonly title: string;
  /** Why this fragment is risky, in plain language. */
  readonly detail: string;
  readonly severity: "warning" | "danger";
}

export interface CommandExplanation {
  /** The cleaned-up text that was analysed. */
  readonly input: string;
  readonly confidence: ExplainConfidence;
  /** One-line answer to "what does this do?". */
  readonly summary: string;
  /** Catalog entry this text matched, when one did. */
  readonly entry?: CatalogEntry;
  /** Other catalog entries worth reading, ordered best-first. */
  readonly related: readonly CatalogEntry[];
  /** Token-by-token breakdown, same shape the lesson panel already renders. */
  readonly anatomy: readonly CommandToken[];
  /** Independently detected hazards, present even when nothing matched. */
  readonly risks: readonly ExplainRisk[];
  /** Worst safety level implied by the text itself, independent of the catalog. */
  readonly impliedSafety: SafetyLevel;
}

/**
 * Patterns that make a command dangerous regardless of which tool it belongs to. These are
 * matched against the RAW text, not the catalog, so a pasted command that is not in the
 * catalog at all is still assessed honestly rather than silently called unknown-and-safe.
 */
const RISK_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly title: string;
  readonly detail: string;
  readonly severity: "warning" | "danger";
}> = [
  {
    // Covers both "-rf" and separated "-r -f"; one rm rule only, so a single command
    // never produces two near-identical warnings that dilute each other.
    pattern: /\brm\b[^|;&]*\s-[a-z]*[rf]/i,
    title: "Deletes files permanently",
    detail: "rm with -r or -f deletes without asking and does not use a recycle bin. There is no undo — check the path twice before running it.",
    severity: "danger",
  },
  {
    pattern: /\bsudo\b/i,
    title: "Runs as administrator",
    detail: "sudo removes the guardrails that normally stop a command damaging the system.",
    severity: "warning",
  },
  {
    pattern: /\bcurl\b[^|]*\|\s*(ba)?sh|\bwget\b[^|]*\|\s*(ba)?sh/i,
    title: "Downloads and runs code in one step",
    detail: "Piping a download straight into a shell runs code you have not read. Download it, read it, then run it.",
    severity: "danger",
  },
  {
    pattern: /\bgit\s+push\b[^|;&]*(--force|-f)\b/i,
    title: "Force push",
    detail: "Force pushing rewrites shared history and can destroy other people's commits.",
    severity: "danger",
  },
  {
    pattern: /\bgit\s+reset\b[^|;&]*--hard/i,
    title: "Discards uncommitted work",
    detail: "git reset --hard throws away local changes permanently.",
    severity: "danger",
  },
  {
    pattern: /\bgit\s+clean\b[^|;&]*-[a-z]*f/i,
    title: "Deletes untracked files",
    detail: "git clean -f removes files Git is not tracking. They are not recoverable from Git.",
    severity: "danger",
  },
  {
    pattern: /\bchmod\b\s+(-R\s+)?777\b/i,
    title: "Removes all file protection",
    detail: "Mode 777 lets any user read, write and execute the file. Almost never the right fix.",
    severity: "danger",
  },
  {
    pattern: /\b(chown|chmod)\b/i,
    title: "Changes file ownership or permissions",
    detail: "Permission changes can lock you out of your own files or expose them to others.",
    severity: "warning",
  },
  {
    pattern: /\bdd\b\s+if=/i,
    title: "Raw disk write",
    detail: "dd writes directly to devices. A wrong target overwrites an entire disk.",
    severity: "danger",
  },
  {
    // Negative lookbehind AND lookahead: ">>" is an append and must not be reported as an
    // overwrite. A false alarm here teaches operators to ignore the real warnings.
    pattern: /(?<![>\d&])>(?!>)\s*\S/,
    title: "Overwrites a file",
    detail: "A single > replaces the file's entire contents. Use >> to add to the end instead.",
    severity: "warning",
  },
  {
    pattern: /--dangerously|--force|--yolo|--no-verify|--skip-permissions/i,
    title: "Bypasses a safety check",
    detail: "This flag disables a protection the tool put there deliberately. Know what it guards before using it.",
    severity: "danger",
  },
  {
    pattern: /\b(kill|pkill|killall)\b\s+-9\b/i,
    title: "Force-kills a process",
    detail: "Signal 9 gives the program no chance to save state or clean up.",
    severity: "warning",
  },
  {
    pattern: /\b(export|echo)\b[^|;&]*\b(token|secret|password|api[_-]?key)\b\s*=/i,
    title: "Handles a credential",
    detail: "Secrets typed at a prompt land in your shell history. Prefer a secret store or an env file.",
    severity: "warning",
  },
  {
    pattern: /\bhistory\s+-c|\bshred\b/i,
    title: "Erases evidence or data irreversibly",
    detail: "This destroys records that cannot be recovered afterwards.",
    severity: "danger",
  },
];

/** Strip a copied shell prompt so pasting "$ hermes chat" works as expected. */
function stripPrompt(raw: string): string {
  return raw.trim().replace(/^(?:[\w.@~[\]/-]*\s*)?[$#>]\s+/, "").trim();
}

function detectRisks(text: string): ExplainRisk[] {
  const risks: ExplainRisk[] = [];
  const seen = new Set<string>();
  for (const candidate of RISK_PATTERNS) {
    if (!candidate.pattern.test(text)) continue;
    if (seen.has(candidate.title)) continue;
    seen.add(candidate.title);
    risks.push({ title: candidate.title, detail: candidate.detail, severity: candidate.severity });
  }
  return risks;
}

function impliedSafetyFrom(risks: readonly ExplainRisk[], entry?: CatalogEntry): SafetyLevel {
  if (risks.some((risk) => risk.severity === "danger")) return "red";
  // Never downgrade what the catalog already asserts about a matched entry.
  if (entry?.safety_level === "red") return "red";
  if (risks.length > 0 || entry?.safety_level === "amber") return "amber";
  return entry ? entry.safety_level : "green";
}

/** Break arbitrary pasted text into tokens, keeping shell operators as their own tokens. */
function tokenizeShell(text: string): string[] {
  return text
    .replace(/([|;&]{1,2}|>>|2>&1|2>|>|<)/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);
}

function anatomyForFreeText(text: string): CommandToken[] {
  const tokens = tokenizeShell(text);
  const programName = tokens[0] ?? text;
  let indexWithinCommand = 0;
  return tokens.map((token) => {
    const role: TokenRole = classifyShellToken(token, indexWithinCommand);
    const explanation = explainShellToken(token, role, indexWithinCommand, programName);
    // After a connector the next word is a new program, so restart positional numbering.
    indexWithinCommand = role === "operator" ? 0 : indexWithinCommand + 1;
    return { text: token, role, explanation };
  });
}

function summarize(
  confidence: ExplainConfidence,
  risks: readonly ExplainRisk[],
  entry?: CatalogEntry,
): string {
  if (entry && confidence === "exact") return entry.description;
  if (entry && confidence === "close") {
    return `Not an exact catalog match. The closest known command is "${entry.command}" — ${entry.description}`;
  }
  if (risks.length > 0) {
    return "This is not in the catalog, but it contains patterns worth understanding before you run it.";
  }
  return "This is not in the local catalog. The breakdown below explains it from its structure alone.";
}

/**
 * Reverse lookup: the operator pastes a command they saw or ran, and gets back what it
 * does, what it is made of, and what about it is risky.
 *
 * Risk detection runs on the raw text and is deliberately independent of the catalog, so
 * an unknown command is never presented as harmless simply because it was not found.
 */
export function explainCommand(index: SearchIndex, rawInput: string): CommandExplanation | null {
  const input = stripPrompt(rawInput);
  if (!input) return null;

  const risks = detectRisks(input);
  const results = searchCatalog(index, input, {}, 6);
  const normalized = input.toLowerCase();

  const exact = results.find((result) => {
    const command = result.entry.command.toLowerCase();
    return command === normalized
      || result.entry.aliases.some((alias) => alias.toLowerCase() === normalized)
      || result.entry.canonical_chord.toLowerCase() === normalized;
  });

  // A near match only counts when the text actually starts with the command, so an
  // unrelated high-scoring row is never presented as "what you ran".
  const close = exact ? undefined : results.find((result) => {
    const command = result.entry.command.toLowerCase();
    return command.length > 2 && (normalized.startsWith(command) || command.startsWith(normalized));
  });

  const entry = exact?.entry ?? close?.entry;
  const confidence: ExplainConfidence = exact ? "exact" : close ? "close" : "unknown";

  // Only offer related commands that share the PROGRAM being explained. Scoring against
  // the whole string made "rm -rf ./build" suggest "--skip-build", which is noise dressed
  // up as guidance — worse than showing nothing.
  const programToken = input.split(/\s+/)[0]?.toLowerCase().replace(/^[$#>]+/, "") ?? "";
  const related = results
    .map((result) => result.entry)
    .filter((candidate) => candidate.id !== entry?.id)
    .filter((candidate) => {
      if (confidence !== "unknown") return true;
      if (programToken.length < 2) return false;
      const command = candidate.command.toLowerCase();
      return command.includes(programToken)
        || candidate.aliases.some((alias) => alias.toLowerCase().includes(programToken));
    })
    .slice(0, 4);

  const anatomy = entry && confidence === "exact" && entry.interface === "hotkey"
    ? []
    : anatomyForFreeText(input);

  return {
    input,
    confidence,
    summary: summarize(confidence, risks, entry),
    entry,
    related,
    anatomy,
    risks,
    impliedSafety: impliedSafetyFrom(risks, entry),
  };
}
