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

interface SearchRecord {
  readonly entry: CatalogEntry;
  readonly command: string;
  readonly commandWords: ReadonlySet<string>;
  readonly aliases: readonly string[];
  readonly aliasWords: ReadonlySet<string>;
  readonly task: string;
  readonly taskWords: ReadonlySet<string>;
  readonly description: string;
  readonly descriptionWords: ReadonlySet<string>;
  readonly product: string;
  readonly productWords: ReadonlySet<string>;
  readonly chord: string;
}

export interface SearchIndex {
  readonly records: readonly SearchRecord[];
  readonly termPostings: ReadonlyMap<string, readonly number[]>;
  readonly chordPostings: ReadonlyMap<string, readonly number[]>;
}

function addPosting(postings: Map<string, number[]>, term: string, recordIndex: number): void {
  const bucket = postings.get(term);
  if (bucket) {
    if (bucket[bucket.length - 1] !== recordIndex) bucket.push(recordIndex);
  } else {
    postings.set(term, [recordIndex]);
  }
}

function tokenGrams(token: string, maxGramLength = 3): Set<string> {
  const grams = new Set([token]);
  for (let length = 1; length <= Math.min(maxGramLength, token.length); length += 1) {
    for (let start = 0; start <= token.length - length; start += 1) {
      grams.add(token.slice(start, start + length));
    }
  }
  return grams;
}

function indexToken(postings: Map<string, number[]>, token: string, recordIndex: number): void {
  for (const term of tokenGrams(token)) addPosting(postings, term, recordIndex);
}

/** Build normalized records and lookup postings once for repeated local queries. */
export function createSearchIndex(entries: readonly CatalogEntry[]): SearchIndex {
  const termPostings = new Map<string, number[]>();
  const chordPostings = new Map<string, number[]>();
  const records = entries.map((entry, recordIndex): SearchRecord => {
    const aliasValues = entry.aliases;
    const command = clean(entry.command);
    const commandWords = new Set(words(entry.command));
    const aliases = aliasValues.map(clean);
    const aliasWords = new Set(aliasValues.flatMap(words));
    const task = clean(entry.task_group).replaceAll("-", " ");
    const taskWords = new Set(words(entry.task_group));
    const description = clean(entry.description);
    const descriptionWords = new Set(words(entry.description));
    const product = clean(entry.product).replaceAll("-", " ");
    const productWords = new Set(words(entry.product));
    const chord = entry.canonical_chord ? normalizeChord(entry.canonical_chord) : "";

    const indexedTokens = new Set([
      ...commandWords, ...aliasWords, ...taskWords, ...descriptionWords, ...productWords,
    ]);
    for (const token of indexedTokens) indexToken(termPostings, token, recordIndex);
    if (chord) addPosting(chordPostings, chord, recordIndex);

    return {
      entry, command, commandWords, aliases, aliasWords, task, taskWords,
      description, descriptionWords, product, productWords, chord,
    };
  });

  return { records, termPostings, chordPostings };
}

interface Match {
  score: number;
  matchedTerms: string[];
}

function scoreRecord(record: SearchRecord, normalizedQuery: string, queryTerms: readonly string[], chordQuery: string): Match | null {
  if (!normalizedQuery) return { score: 0, matchedTerms: [] };
  if (chordQuery && chordQuery === record.chord) {
    return { score: 1_000_000, matchedTerms: [chordQuery] };
  }

  if (queryTerms.length === 0) return null;
  let score = record.command === normalizedQuery ? 500_000 : 0;
  if (record.aliases.includes(normalizedQuery)) score += 100_000;
  if (record.task === normalizedQuery) score += 10_000;
  if (record.description === normalizedQuery) score += 1_000;
  if (record.product === normalizedQuery) score += 100;

  const matchedTerms: string[] = [];
  for (const term of queryTerms) {
    if (record.commandWords.has(term)) score += 20_000;
    else if (record.aliasWords.has(term) || record.aliases.some((alias) => alias.includes(term))) score += 4_000;
    else if (record.taskWords.has(term) || record.task.includes(term)) score += 800;
    else if (record.descriptionWords.has(term) || record.description.includes(term)) score += 120;
    else if (record.productWords.has(term) || record.product.includes(term)) score += 20;
    else return null;
    matchedTerms.push(term);
  }

  if (record.aliases.some((alias) => alias.includes(normalizedQuery))) score += 20_000;
  if (record.task.includes(normalizedQuery)) score += 2_000;
  if (record.description.includes(normalizedQuery)) score += 300;
  if (record.product.includes(normalizedQuery)) score += 40;
  return { score, matchedTerms };
}

function passesFilters(entry: CatalogEntry, filters: SearchFilters): boolean {
  return (!filters.product || entry.product === filters.product)
    && (!filters.interface || entry.interface === filters.interface)
    && (!filters.task || entry.task_group === filters.task)
    && (!filters.safety || entry.safety_level === filters.safety);
}

function intersectSorted(left: readonly number[], right: readonly number[]): number[] {
  const result: number[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      result.push(left[leftIndex]);
      leftIndex += 1;
      rightIndex += 1;
    } else if (left[leftIndex] < right[rightIndex]) leftIndex += 1;
    else rightIndex += 1;
  }
  return result;
}

function candidatesForTerm(index: SearchIndex, term: string): readonly number[] {
  if (term.length <= 3) return index.termPostings.get(term) ?? [];
  const trigrams = [...tokenGrams(term, 3)].filter((gram) => gram.length === 3);
  let candidates: readonly number[] = index.termPostings.get(trigrams[0]) ?? [];
  for (const trigram of trigrams.slice(1)) {
    candidates = intersectSorted(candidates, index.termPostings.get(trigram) ?? []);
    if (candidates.length === 0) break;
  }
  return candidates;
}

function candidateIndexes(index: SearchIndex, queryTerms: readonly string[], chordQuery: string): readonly number[] {
  const chordCandidates = chordQuery ? index.chordPostings.get(chordQuery) : undefined;
  if (chordCandidates?.length) return chordCandidates;
  if (queryTerms.length === 0) return index.records.map((_, recordIndex) => recordIndex);
  let candidates = candidatesForTerm(index, queryTerms[0]);
  for (const term of queryTerms.slice(1)) {
    candidates = intersectSorted(candidates, candidatesForTerm(index, term));
    if (candidates.length === 0) break;
  }
  return candidates;
}

export function searchCatalog(
  index: SearchIndex,
  query: string,
  filters: SearchFilters = {},
  limit = 50,
): SearchResult[] {
  const normalizedQuery = clean(query);
  const queryTerms = words(query);
  const chordQuery = looksLikeChord(query) ? normalizeChord(query) : "";
  const results: SearchResult[] = [];

  for (const recordIndex of candidateIndexes(index, queryTerms, chordQuery)) {
    const record = index.records[recordIndex];
    if (!passesFilters(record.entry, filters)) continue;
    const match = scoreRecord(record, normalizedQuery, queryTerms, chordQuery);
    if (!match) continue;
    results.push({ entry: record.entry, score: match.score, matchedTerms: match.matchedTerms, unavailable: !record.entry.available });
  }
  results.sort((left, right) => Number(left.unavailable) - Number(right.unavailable)
    || right.score - left.score
    || left.entry.id.localeCompare(right.entry.id));
  return results.slice(0, Math.max(0, limit));
}
