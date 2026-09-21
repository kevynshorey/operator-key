import type { CatalogEntry, Product, SafetyLevel } from "./catalog";

export type TokenRole =
  | "program" | "subcommand" | "flag" | "flag-value" | "placeholder"
  | "modifier" | "key" | "slash-command" | "path" | "operator" | "literal";

export interface CommandToken {
  text: string;
  role: TokenRole;
  /** Plain-English explanation. Sourced from the catalog when `sourcedFrom` is set. */
  explanation: string;
  /** Catalog entry id this explanation came from, when one documents the token. */
  sourcedFrom?: string;
}

export interface GlossaryTerm {
  term: string;
  definition: string;
}

export interface CommandLesson {
  headline: string;
  anatomy: CommandToken[];
  glossary: GlossaryTerm[];
  safetyBriefing: string;
  practiceHint: string;
}

export interface TeachingIndex {
  /** `product\u0000token` to the catalog entry documenting that flag or subcommand. */
  readonly byToken: ReadonlyMap<string, CatalogEntry>;
}

const MODIFIER_NAMES: Record<string, string> = {
  ctrl: "Control key, held while pressing the next key.",
  control: "Control key, held while pressing the next key.",
  alt: "Alt key, held while pressing the next key.",
  option: "Option key, held while pressing the next key.",
  shift: "Shift key, held while pressing the next key.",
  super: "Super key (the Windows or Command key). On Omarchy this is the desktop's main modifier.",
  cmd: "Command key, held while pressing the next key.",
  meta: "Meta key, held while pressing the next key.",
  win: "Windows key, held while pressing the next key.",
};

const GLOSSARY: ReadonlyArray<{ term: string; definition: string; triggers: readonly string[] }> = [
  { term: "flag", definition: "A switch starting with - or -- that changes how a command behaves without changing which command runs.", triggers: ["--", "-"] },
  { term: "session", definition: "One continuous conversation with an agent, including its history and context. Sessions can be resumed later.", triggers: ["session", "resume", "continue", "chat"] },
  { term: "daemon / background process", definition: "A program that keeps running after your command returns, instead of finishing and giving the prompt back.", triggers: ["daemon", "background", "gateway", "serve", "start", "service"] },
  { term: "git branch", definition: "A named line of development. Work on a branch stays separate from main until it is merged.", triggers: ["branch", "checkout", "merge", "rebase"] },
  { term: "git worktree", definition: "A second working folder for the same repository, so two agents can edit different branches without colliding.", triggers: ["worktree"] },
  { term: "commit", definition: "A saved snapshot of your changes with a message. Committing records work; it does not publish it.", triggers: ["commit"] },
  { term: "push", definition: "Sending committed work from your machine to the shared remote repository, where others and CI can see it.", triggers: ["push"] },
  { term: "standard output / piping", definition: "Text a command prints. The | symbol feeds that text into the next command instead of your screen.", triggers: ["|", "grep", "output", "print", "tail", "head"] },
  { term: "elevated privilege", definition: "Running as administrator with sudo. It removes the guardrails that normally stop a command damaging the system.", triggers: ["sudo", "root", "privilege", "chmod", "chown"] },
  { term: "environment variable", definition: "A named value the shell hands to programs, commonly used for settings and API keys.", triggers: ["env", "export", "variable"] },
  { term: "slash command", definition: "A command typed inside a running agent session, starting with /. It controls the agent, not the operating system.", triggers: ["/"] },
  { term: "agent delegation", definition: "Handing a task to a separate agent that works on its own and reports back, so several things progress at once.", triggers: ["delegate", "spawn", "subagent", "agent", "parallel"] },
  { term: "context window", definition: "How much conversation an agent can hold at once. When it fills, older detail is compressed or lost.", triggers: ["context", "compress", "memory", "token"] },
  { term: "configuration file", definition: "A file holding settings a program reads at startup. Editing it changes behaviour without changing code.", triggers: ["config", "yaml", "toml", "json", "settings"] },
];

const SAFETY_BRIEFINGS: Record<SafetyLevel, string> = {
  green: "Green means this reads or displays state without changing it. Safe to try while you are learning.",
  amber: "Amber means this changes something. Not dangerous, but read what it will affect before you confirm.",
  red: "Red means this can destroy work or weaken protection. Understand it fully and have a recovery path before running it.",
};

function tokenKey(product: Product, token: string): string {
  return `${product}\u0000${token.toLowerCase()}`;
}

/**
 * Map product-scoped command and flag tokens to the catalog entries documenting them, so
 * a flag inside a longer command can be explained from the catalog rather than invented.
 */
export function createTeachingIndex(entries: readonly CatalogEntry[]): TeachingIndex {
  const byToken = new Map<string, CatalogEntry>();
  const register = (product: Product, token: string, entry: CatalogEntry): void => {
    const key = tokenKey(product, token);
    const existing = byToken.get(key);
    // Prefer available entries, then the shortest command: the most precise definition.
    if (!existing
      || (!existing.available && entry.available)
      || (existing.available === entry.available && entry.command.length < existing.command.length)) {
      byToken.set(key, entry);
    }
  };

  for (const entry of entries) {
    if (entry.interface === "cli-flag") {
      for (const token of entry.command.split(/\s+/)) {
        if (token.startsWith("-")) register(entry.product, token.replace(/[=,].*$/, ""), entry);
      }
      for (const alias of entry.aliases) {
        if (alias.startsWith("-")) register(entry.product, alias.replace(/[=,].*$/, ""), entry);
      }
    } else if (entry.interface === "slash-command") {
      register(entry.product, entry.command.split(/\s+/)[0], entry);
    }
  }
  return { byToken };
}

function describeFlag(token: string): string {
  return token.startsWith("--")
    ? `Long-form flag. It modifies the command's behaviour; the catalog holds no separate entry documenting it for this product.`
    : `Short flag. Single-letter switches can often be combined, as in -la.`;
}

function classifyShellToken(token: string, index: number): TokenRole {
  if (index === 0) return "program";
  if (token.startsWith("--") || /^-[A-Za-z]/.test(token)) return "flag";
  if (/^[<[{].*[>\]}]$/.test(token) || /^[A-Z_]{2,}$/.test(token)) return "placeholder";
  if (token.includes("/") || token.startsWith("~") || token.startsWith(".")) return "path";
  if (["|", ">", ">>", "<", "&&", "||", ";", "&"].includes(token)) return "operator";
  return "subcommand";
}

function explainShellToken(token: string, role: TokenRole, index: number, entry: CatalogEntry): string {
  switch (role) {
    case "program":
      return `The program being run. Everything after it tells ${token} what to do.`;
    case "flag":
      return describeFlag(token);
    case "placeholder":
      return "A placeholder. Replace it with your own value; do not type the brackets.";
    case "path":
      return "A filesystem path. ~ means your home folder, . means the current folder.";
    case "operator":
      return "A shell operator. It connects or redirects commands rather than being part of one.";
    default:
      return index === 1
        ? `The subcommand. It selects which part of ${entry.command.split(/\s+/)[0]} you are using.`
        : "An argument passed to the command.";
  }
}

function buildChordAnatomy(entry: CatalogEntry): CommandToken[] {
  const source = entry.canonical_chord || entry.command;
  return source.split(/\s*\+\s*/).filter(Boolean).map((part) => {
    const normalized = part.toLowerCase().trim();
    const modifier = MODIFIER_NAMES[normalized];
    return modifier
      ? { text: part.trim(), role: "modifier" as const, explanation: modifier }
      : {
        text: part.trim(),
        role: "key" as const,
        explanation: `The key pressed while the modifiers are held. Together this triggers: ${entry.description}`,
      };
  });
}

function buildShellAnatomy(teaching: TeachingIndex, entry: CatalogEntry): CommandToken[] {
  return entry.command.split(/\s+/).filter(Boolean).map((token, index) => {
    const role = classifyShellToken(token, index);
    const documented = teaching.byToken.get(tokenKey(entry.product, token.replace(/[=,].*$/, "")));
    if (documented && documented.id !== entry.id && (role === "flag" || index === 0)) {
      return { text: token, role, explanation: documented.description, sourcedFrom: documented.id };
    }
    return { text: token, role, explanation: explainShellToken(token, role, index, entry) };
  });
}

function buildSlashAnatomy(entry: CatalogEntry): CommandToken[] {
  const [head, ...rest] = entry.command.split(/\s+/).filter(Boolean);
  const tokens: CommandToken[] = [{
    text: head,
    role: "slash-command",
    explanation: `Typed inside a running ${entry.product} session, not at the shell prompt. The leading / marks it as a command to the agent.`,
  }];
  for (const token of rest) {
    tokens.push(/^[<[{].*[>\]}]$/.test(token)
      ? { text: token, role: "placeholder", explanation: "A placeholder. Replace it with your own value; do not type the brackets." }
      : { text: token, role: "subcommand", explanation: "An option passed to the slash command." });
  }
  return tokens;
}

function buildGlossary(entry: CatalogEntry, anatomy: readonly CommandToken[]): GlossaryTerm[] {
  const haystack = `${entry.command} ${entry.description} ${entry.context} ${entry.task_group}`.toLowerCase();
  const hasFlag = anatomy.some((token) => token.role === "flag");
  const terms: GlossaryTerm[] = [];

  for (const item of GLOSSARY) {
    const triggered = item.triggers.some((trigger) => (
      trigger === "--" || trigger === "-" ? hasFlag
        : trigger === "/" ? entry.interface === "slash-command"
          : trigger === "|" ? entry.command.includes("|")
            : haystack.includes(trigger)
    ));
    if (triggered) terms.push({ term: item.term, definition: item.definition });
  }
  return terms;
}

function practiceHint(entry: CatalogEntry): string {
  if (entry.interface === "hotkey") {
    return "Press it once and watch what changes on screen. Hotkeys are the fastest safe way to build muscle memory.";
  }
  if (entry.safety_level === "red" || entry.destructive) {
    return "Do not practise this on real work. Read its help output first, then try it on a disposable copy.";
  }
  if (entry.safety_level === "amber") {
    return "Run it somewhere you can afford to be wrong, such as a scratch folder or a throwaway branch, before using it on real work.";
  }
  return "Safe to run as-is. Copy it, run it, and read the output carefully before moving on.";
}

/** Explain a catalog entry so that using it teaches the operator something durable. */
export function buildCommandLesson(teaching: TeachingIndex, entry: CatalogEntry): CommandLesson {
  const anatomy = entry.interface === "hotkey"
    ? buildChordAnatomy(entry)
    : entry.interface === "slash-command"
      ? buildSlashAnatomy(entry)
      : buildShellAnatomy(teaching, entry);

  const surface = entry.interface === "hotkey"
    ? "a desktop key combination"
    : entry.interface === "slash-command"
      ? `a command typed inside a running ${entry.product} session`
      : "a command typed at your terminal prompt";

  return {
    headline: `${entry.description} — ${surface}.`,
    anatomy,
    glossary: buildGlossary(entry, anatomy),
    safetyBriefing: SAFETY_BRIEFINGS[entry.safety_level],
    practiceHint: practiceHint(entry),
  };
}
