import type { CatalogEntry } from "./catalog";

export type PredictionKind = "phrase" | "completion" | "next-word" | "intent";

/**
 * Function words that should not drive an intent match. Kept local to prediction so the
 * search module's list can evolve independently.
 */
const PREDICT_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "i", "me", "my", "mine", "we", "our", "us", "you", "your", "yours", "it", "its",
  "of", "for", "to", "in", "on", "at", "by", "with", "from", "into", "onto", "about",
  "and", "or", "but", "so", "as", "is", "am", "are", "was", "were", "be", "been",
  "do", "does", "did", "please", "some", "any", "all", "if", "then", "want", "need",
  "how", "what", "can", "could", "would", "should", "help", "let",
]);

export interface PredictionSuggestion {
  /** Full input text the operator holds after accepting the suggestion. */
  completion: string;
  /**
   * Text beyond what the operator already typed, rendered as inline ghost text.
   * Empty for "intent" suggestions, which REPLACE the typed text rather than extending
   * it — so ghost text is only shown when `completion` truly starts with the query.
   */
  ghost: string;
  kind: PredictionKind;
  score: number;
}

export interface PredictionIndex {
  readonly phrases: ReadonlyMap<string, number>;
  readonly unigrams: ReadonlyMap<string, number>;
  readonly bigrams: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly starters: readonly string[];
}

/**
 * Words that carry no intent on their own. They still seed bigram context so
 * "resume the " predicts correctly, but they are never offered as a suggestion.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "for", "from",
  "has", "have", "how", "i", "in", "into", "is", "it", "its", "me", "my", "not", "of",
  "on", "onto", "or", "our", "that", "the", "their", "them", "then", "there", "these",
  "this", "to", "up", "use", "used", "was", "were", "what", "when", "where", "which",
  "will", "with", "you", "your",
]);

const MAX_PHRASE_WORDS = 8;
const MIN_TOKEN_LENGTH = 2;

/**
 * Normalize for matching while preserving character positions, so the predicted tail can
 * be appended to the operator's literal text without disturbing their casing or spacing.
 * Only collapsing and trimming change length, and both only ever remove a prefix or an
 * interior run, never reorder.
 */
function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/[_–—-]/g, " ").replace(/\s+/g, " ").trim();
}

function phraseWords(value: string): string[] {
  return normalizePhrase(value).split(/[^a-z0-9+/]+/).filter(Boolean);
}

function increment(counter: Map<string, number>, key: string, weight: number): void {
  counter.set(key, (counter.get(key) ?? 0) + weight);
}

function suggestable(token: string): boolean {
  return token.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(token) && /[a-z]/.test(token);
}

function addPhrase(
  phrases: Map<string, number>,
  unigrams: Map<string, number>,
  bigrams: Map<string, Map<string, number>>,
  raw: string,
  weight: number,
): void {
  const tokens = phraseWords(raw);
  if (tokens.length === 0 || tokens.length > MAX_PHRASE_WORDS) return;

  increment(phrases, tokens.join(" "), weight);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (suggestable(token)) increment(unigrams, token, weight);
    const next = tokens[index + 1];
    if (!next || !suggestable(next)) continue;
    let transitions = bigrams.get(token);
    if (!transitions) {
      transitions = new Map<string, number>();
      bigrams.set(token, transitions);
    }
    increment(transitions, next, weight);
  }
}

/**
 * Derive a deterministic phrase, unigram and bigram model from the checked-in catalog.
 * Nothing outside the catalog contributes, so predictions can only ever steer the
 * operator toward vocabulary the instrument actually understands.
 */
export function createPredictionIndex(entries: readonly CatalogEntry[]): PredictionIndex {
  const phrases = new Map<string, number>();
  const unigrams = new Map<string, number>();
  const bigrams = new Map<string, Map<string, number>>();
  const taskWeights = new Map<string, number>();

  for (const entry of entries) {
    const weight = entry.available ? 2 : 1;
    addPhrase(phrases, unigrams, bigrams, entry.description, weight * 3);
    addPhrase(phrases, unigrams, bigrams, entry.task_group, weight);
    addPhrase(phrases, unigrams, bigrams, entry.category, weight);
    for (const alias of entry.aliases) addPhrase(phrases, unigrams, bigrams, alias, weight);
    if (entry.interface !== "hotkey") {
      addPhrase(phrases, unigrams, bigrams, entry.command, weight);
    }
    increment(taskWeights, normalizePhrase(entry.task_group), weight);
  }

  const starters = [...taskWeights.entries()]
    .sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || leftKey.localeCompare(rightKey))
    .map(([task]) => task);

  return { phrases, unigrams, bigrams, starters };
}

function compose(
  query: string,
  candidate: string,
  normalizedQuery: string,
  kind: PredictionKind,
  score: number,
): PredictionSuggestion | null {
  if (!candidate.startsWith(normalizedQuery)) return null;
  const tail = candidate.slice(normalizedQuery.length);
  // The operator already typed the separator, so never emit a second one.
  const ghost = /\s$/.test(query) ? tail.replace(/^\s+/, "") : tail;
  if (!ghost.trim()) return null;
  return { completion: query + ghost, ghost, kind, score };
}

function rank(suggestions: readonly PredictionSuggestion[], limit: number): PredictionSuggestion[] {
  const best = new Map<string, PredictionSuggestion>();
  for (const suggestion of suggestions) {
    const key = normalizePhrase(suggestion.completion);
    const existing = best.get(key);
    if (!existing || suggestion.score > existing.score) best.set(key, suggestion);
  }
  return [...best.values()]
    .sort((left, right) => right.score - left.score || left.completion.localeCompare(right.completion))
    .slice(0, Math.max(0, limit));
}

/**
 * Predict how the operator intends to finish their sentence.
 *
 * Four signals are combined, strongest first: the whole query as the prefix of a known
 * catalog phrase, completion of the word being typed, the most likely following word,
 * and — when the operator is writing prose rather than a prefix — the catalog phrase
 * whose meaning best covers the words they have already typed.
 */
export function predictIntent(index: PredictionIndex, query: string, limit = 5): PredictionSuggestion[] {
  const normalizedQuery = normalizePhrase(query);
  if (!normalizedQuery) return [];

  const endsWithSpace = /\s$/.test(query);
  const tokens = phraseWords(query);
  const lastToken = tokens[tokens.length - 1] ?? "";
  const suggestions: PredictionSuggestion[] = [];

  for (const [phrase, count] of index.phrases) {
    if (phrase === normalizedQuery) continue;
    const suggestion = compose(query, phrase, normalizedQuery, "phrase", 1_000_000 + count);
    if (suggestion) suggestions.push(suggestion);
  }

  if (!endsWithSpace && lastToken) {
    const head = normalizedQuery.slice(0, normalizedQuery.length - lastToken.length);
    for (const [token, count] of index.unigrams) {
      if (token === lastToken || !token.startsWith(lastToken)) continue;
      const suggestion = compose(query, head + token, normalizedQuery, "completion", 10_000 + count);
      if (suggestion) suggestions.push(suggestion);
    }
  }

  if (endsWithSpace && lastToken) {
    const transitions = index.bigrams.get(lastToken);
    if (transitions) {
      for (const [next, count] of transitions) {
        const suggestion = compose(query, `${normalizedQuery} ${next}`, normalizedQuery, "next-word", 100 + count);
        if (suggestion) suggestions.push(suggestion);
      }
    }
  }

  // Prose fallback. "review my code" is not the prefix of any catalog phrase, but it
  // plainly means "code review" — offer the real intent instead of letter-matched noise.
  const contentTokens = tokens.filter((token) => !PREDICT_STOPWORDS.has(token));
  if (contentTokens.length > 0) {
    for (const [phrase, count] of index.phrases) {
      if (phrase === normalizedQuery || phrase.startsWith(normalizedQuery)) continue;
      const phraseTokens = phraseWords(phrase);
      if (phraseTokens.length === 0) continue;
      let covered = 0;
      for (const token of contentTokens) {
        if (phraseTokens.some((word) => word === token || word.startsWith(token) || token.startsWith(word))) covered += 1;
      }
      if (covered === 0) continue;
      // Require the phrase to be mostly explained by what was typed, so a single shared
      // word cannot drag in an unrelated command.
      const coverage = covered / contentTokens.length;
      const focus = covered / phraseTokens.length;
      if (coverage < 0.6 || focus < 0.4) continue;
      suggestions.push({
        completion: phrase,
        ghost: "",
        kind: "intent",
        score: Math.round(1_000 * coverage * focus) + count,
      });
    }
  }

  return rank(suggestions, limit);
}

/** Real, achievable intents for an empty field so the instrument is never a blank box. */
export function starterPrompts(index: PredictionIndex, limit = 6): string[] {
  return index.starters.slice(0, Math.max(0, limit));
}
