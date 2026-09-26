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
  control: "ctrl", ctl: "ctrl", ctrl: "ctrl", "⌃": "ctrl",
  option: "alt", alt: "alt", "⌥": "alt",
  shift: "shift", "⇧": "shift",
  cmd: "super", command: "super", meta: "super", win: "super", windows: "super", super: "super",
  "⌘": "super", "⊞": "super",
};

function clean(value: string): string {
  return value.toLowerCase().trim().replace(/[_–—]/g, "-").replace(/\s+/g, " ");
}

/**
 * Modifier GLYPHS (not words) may arrive glyph-packed with no separators — ⌘⇧A is how
 * macOS renders a chord. Pad only single-character glyph aliases with spaces so the
 * ordinary tokenizer sees them as separate tokens. ASCII words are never split:
 * "shifta" and "command centre" must stay whole and read as prose.
 */
const MODIFIER_GLYPHS = /([⌘⇧⌥⌃⊞])/g;

function expandModifierGlyphs(value: string): string {
  return value.replace(MODIFIER_GLYPHS, " $1 ");
}

/**
 * Pure function words. They carry no discriminating power in a command catalog, so they
 * are allowed to contribute score but are never allowed to veto a match. Verbs and nouns
 * are deliberately excluded — "make", "get" and "use" are real commands.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "i", "me", "my", "mine", "we", "our", "us", "you", "your", "yours", "it", "its",
  "of", "for", "to", "in", "on", "at", "by", "with", "from", "into", "onto", "about",
  "and", "or", "but", "so", "as", "is", "am", "are", "was", "were", "be", "been",
  "do", "does", "did", "please", "some", "any", "all", "if", "then",
]);

/**
 * Natural-language preambles a learner types before the real intent. Only stripped from the
 * START of a query so a mid-query word is never silently discarded.
 */
const INTENT_PREAMBLE = /^(?:(?:i(?:'d)? (?:want|need|would like|would want|wish) to|i want|i need|how (?:do|can|would) i|how to|show me (?:how to )?|help me(?: to)?|can i|could i|let me|is there a way to|what(?:'s| is) the (?:command|way) (?:to|for))\s+)+/;

function stripIntentPreamble(value: string): string {
  const stripped = clean(value).replace(INTENT_PREAMBLE, "");
  // Never strip the query down to nothing — a bare preamble is still a query.
  return stripped.trim() ? stripped : clean(value);
}

function words(value: string): string[] {
  return clean(value).replace(/^\/+/, "").split(/[^a-z0-9]+/).filter(Boolean);
}

export function normalizeChord(value: string): string {
  if (typeof value !== "string") return "";
  const parts = clean(expandModifierGlyphs(value))
    .replace(/\s+plus\s+/g, " + ")
    .replace(/\s*\+\s*/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const normalized = parts.map((part) => MODIFIER_ALIASES[part] ?? part);
  const modifiers = MODIFIER_ORDER.filter((modifier) => normalized.includes(modifier));
  const keys = normalized.filter((part) => !MODIFIER_ORDER.includes(part as (typeof MODIFIER_ORDER)[number]));
  return [...modifiers, ...keys].join("+");
}

const NAMED_KEYS = new Set([
  "backspace", "delete", "del", "down", "end", "enter", "escape", "esc", "home",
  "insert", "left", "pageup", "pagedown", "pgup", "pgdn", "print", "return",
  "right", "space", "tab", "up", "comma", "period", "minus", "equal",
]);

function looksLikeChord(query: string): boolean {
  const normalized = clean(expandModifierGlyphs(query)).replace(/\s+plus\s+/g, " + ");
  const parts = normalized.replace(/\s*\+\s*/g, " ").split(/\s+/).filter(Boolean);
  if (!parts.some((part) => part in MODIFIER_ALIASES)) return false;
  const keys = parts.filter((part) => !(part in MODIFIER_ALIASES));
  // Require a plausible key token unless the operator explicitly wrote a chord
  // separator. This keeps ordinary language such as "control panel" in text search.
  return normalized.includes("+") || keys.some((part) => (
    part.length === 1 || NAMED_KEYS.has(part) || /^f(?:[1-9]|1[0-2])$/.test(part) || part.startsWith("xf86")
  ));
}

/** Return a canonical chord only when the query has recognizable shortcut syntax. */
export function parseChordQuery(query: string): string | null {
  if (typeof query !== "string") return null;
  return looksLikeChord(query) ? normalizeChord(query) : null;
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

function scoreRecord(
  record: SearchRecord,
  normalizedQuery: string,
  queryTerms: readonly string[],
  chordQuery: string,
  optionalTerms: ReadonlySet<string>,
): Match | null {
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
    // Filler and unknown words may add score but must never discard an otherwise
    // good match, so an operator can type a full sentence and still be understood.
    else if (optionalTerms.has(term)) continue;
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

/** Union of records matching ANY term — the widening pass for sentence-like queries. */
function unionCandidates(index: SearchIndex, queryTerms: readonly string[]): readonly number[] {
  const union = new Set<number>();
  for (const term of queryTerms) {
    for (const recordIndex of candidatesForTerm(index, term)) union.add(recordIndex);
  }
  return [...union].sort((left, right) => left - right);
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
  const chordQuery = parseChordQuery(query) ?? "";
  // A chord-looking query is a reverse lookup, not an intent sentence. If no catalog
  // entry owns that exact normalized chord, token-level matching would turn the modifier
  // (usually "super") into dozens of unrelated, false-positive results.
  if (chordQuery && !index.chordPostings.get(chordQuery)?.length) return [];

  // A learner types "how do I review my code" — strip the preamble, then treat pure
  // function words as optional so the real intent words drive the match.
  const allTerms = words(stripIntentPreamble(query));
  const contentTerms = allTerms.filter((term) => !STOPWORDS.has(term));
  const searchTerms = contentTerms.length > 0 ? contentTerms : allTerms;
  const optionalTerms = new Set(allTerms.filter((term) => !searchTerms.includes(term)));

  const collect = (terms: readonly string[], optional: ReadonlySet<string>): SearchResult[] => {
    const found: SearchResult[] = [];
    for (const recordIndex of candidateIndexes(index, terms, chordQuery)) {
      const record = index.records[recordIndex];
      if (!passesFilters(record.entry, filters)) continue;
      const match = scoreRecord(record, normalizedQuery, terms, chordQuery, optional);
      if (!match) continue;
      found.push({ entry: record.entry, score: match.score, matchedTerms: match.matchedTerms, unavailable: !record.entry.available });
    }
    return found;
  };

  let results = collect(searchTerms, optionalTerms);

  // Graceful degradation for sentences. When an operator writes prose that matches nothing
  // as a whole, surface the entries that still understand most of it rather than an empty
  // screen. Deliberately conservative:
  //   - never when an explicit filter is set (the operator narrowed on purpose, and
  //     silently widening the match would make the filter look broken),
  //   - only for genuinely sentence-like queries, and
  //   - only for entries that account for at least half of the content words, so
  //     nonsense still returns nothing rather than a single incidental hit.
  const hasActiveFilter = Boolean(filters.product || filters.interface || filters.task || filters.safety);
  if (results.length === 0 && !hasActiveFilter && searchTerms.length >= 3) {
    const everyTermOptional = new Set(allTerms);
    const seen = new Set<string>();
    const relaxed: SearchResult[] = [];
    for (const recordIndex of unionCandidates(index, searchTerms)) {
      const record = index.records[recordIndex];
      if (!passesFilters(record.entry, filters)) continue;
      const match = scoreRecord(record, normalizedQuery, searchTerms, chordQuery, everyTermOptional);
      if (!match) continue;
      if (match.matchedTerms.length / searchTerms.length < 0.5) continue;
      if (seen.has(record.entry.id)) continue;
      seen.add(record.entry.id);
      // Partial understanding must never outrank a full match.
      relaxed.push({
        entry: record.entry,
        score: Math.round(match.score / 2),
        matchedTerms: match.matchedTerms,
        unavailable: !record.entry.available,
      });
    }
    results = relaxed;
  }

  results.sort((left, right) => Number(left.unavailable) - Number(right.unavailable)
    || right.score - left.score
    || left.entry.id.localeCompare(right.entry.id));
  return results.slice(0, Math.max(0, limit));
}
