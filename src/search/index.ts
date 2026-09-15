import type { CatalogEntry, InterfaceType, Product, SafetyLevel, TaskGroup } from "../catalog";

export interface SearchFilters {
  product?: Product;
  interface?: InterfaceType;
  task?: TaskGroup;
  safety?: SafetyLevel;
}

export interface SearchResult {
  entry: CatalogEntry;
  score: number;
  matchedTerms: string[];
  unavailable: boolean;
}

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "super"] as const;
const MODIFIER_ALIASES: Record<string, string> = {
  control: "ctrl", ctl: "ctrl", ctrl: "ctrl",
  option: "alt", alt: "alt",
  shift: "shift",
  cmd: "super", command: "super", meta: "super", win: "super", super: "super",
};

function clean(value: string): string {
  return value.toLowerCase().trim().replace(/[_–—]/g, "-").replace(/\s+/g, " ");
}

function words(value: string): string[] {
  return clean(value).replace(/^\/+/, "").split(/[^a-z0-9]+/).filter(Boolean);
}

export function normalizeChord(value: string): string {
  const parts = clean(value).replace(/\s*\+\s*/g, " ").split(/\s+/).filter(Boolean);
  const normalized = parts.map((part) => MODIFIER_ALIASES[part] ?? part);
  const modifiers = MODIFIER_ORDER.filter((modifier) => normalized.includes(modifier));
  const keys = normalized.filter((part) => !MODIFIER_ORDER.includes(part as (typeof MODIFIER_ORDER)[number]));
  return [...modifiers, ...keys].join("+");
}

function looksLikeChord(query: string): boolean {
  const parts = clean(query).replace(/\s*\+\s*/g, " ").split(/\s+/);
  return parts.length > 1 && parts.some((part) => part in MODIFIER_ALIASES);
}

interface Match {
  score: number;
  matchedTerms: string[];
}

function scoreEntry(entry: CatalogEntry, query: string): Match | null {
  const normalizedQuery = clean(query);
  if (!normalizedQuery) return { score: 0, matchedTerms: [] };

  const chordQuery = looksLikeChord(query) ? normalizeChord(query) : "";
  if (chordQuery && chordQuery === entry.canonical_chord) {
    return { score: 1_000_000, matchedTerms: [chordQuery] };
  }

  const queryTerms = words(query);
  if (queryTerms.length === 0) return null;
  const command = clean(entry.command);
  const commandWords = new Set(words(entry.command));
  const aliases = entry.aliases.map(clean);
  const aliasWords = new Set(entry.aliases.flatMap(words));
  const task = clean(entry.task_group).replaceAll("-", " ");
  const taskWords = new Set(words(entry.task_group));
  const description = clean(entry.description);
  const descriptionWords = new Set(words(entry.description));
  const product = clean(entry.product).replaceAll("-", " ");
  const productWords = new Set(words(entry.product));

  let score = command === normalizedQuery ? 500_000 : 0;
  if (aliases.includes(normalizedQuery)) score += 100_000;
  if (task === normalizedQuery) score += 10_000;
  if (description === normalizedQuery) score += 1_000;
  if (product === normalizedQuery) score += 100;

  const matchedTerms: string[] = [];
  for (const term of queryTerms) {
    if (commandWords.has(term)) score += 20_000;
    else if (aliasWords.has(term) || aliases.some((alias) => alias.includes(term))) score += 4_000;
    else if (taskWords.has(term) || task.includes(term)) score += 800;
    else if (descriptionWords.has(term) || description.includes(term)) score += 120;
    else if (productWords.has(term) || product.includes(term)) score += 20;
    else return null;
    matchedTerms.push(term);
  }

  if (aliases.some((alias) => alias.includes(normalizedQuery))) score += 20_000;
  if (task.includes(normalizedQuery)) score += 2_000;
  if (description.includes(normalizedQuery)) score += 300;
  if (product.includes(normalizedQuery)) score += 40;
  return { score, matchedTerms };
}

function passesFilters(entry: CatalogEntry, filters: SearchFilters): boolean {
  return (!filters.product || entry.product === filters.product)
    && (!filters.interface || entry.interface === filters.interface)
    && (!filters.task || entry.task_group === filters.task)
    && (!filters.safety || entry.safety_level === filters.safety);
}

export function searchCatalog(
  entries: readonly CatalogEntry[],
  query: string,
  filters: SearchFilters = {},
  limit = 50,
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const entry of entries) {
    if (!passesFilters(entry, filters)) continue;
    const match = scoreEntry(entry, query);
    if (!match) continue;
    results.push({ entry, score: match.score, matchedTerms: match.matchedTerms, unavailable: !entry.available });
  }
  results.sort((left, right) => Number(left.unavailable) - Number(right.unavailable)
    || right.score - left.score
    || left.entry.id.localeCompare(right.entry.id));
  return results.slice(0, Math.max(0, limit));
}
