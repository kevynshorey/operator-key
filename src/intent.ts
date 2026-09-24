import { invoke } from "@tauri-apps/api/core";
import type { CatalogEntry } from "./catalog";
import type { SearchFilters, SearchResult } from "./search";

export type SparkConfidence = "high" | "medium" | "low";
export type SparkSequence = 1 | 2 | 3 | 4 | 5;

export interface SparkRecommendation {
  entryId: string;
  sequence: SparkSequence;
  purpose: string;
  inputHint: string;
  confidence: SparkConfidence;
}

export interface SparkIntentPlan {
  summary: string;
  assumptions: string[];
  recommendations: SparkRecommendation[];
  gaps: string[];
  model: string;
}

export interface SparkStatus {
  available: boolean;
  loggedIn: boolean;
  model: string;
  /** Which backend is configured: "disabled", "ollama", "openai-compatible", "codex", or "opencode". */
  provider: string;
  /** Absolute path of the operator's reasoning config, for actionable UI messages. */
  configPath: string;
  message: string;
}

export interface IntentReasoner {
  status(): Promise<SparkStatus>;
  reason(intent: string, candidateIds: readonly string[]): Promise<SparkIntentPlan>;
}

export interface MappedSparkRecommendation extends SparkRecommendation {
  entry: CatalogEntry;
}

export type IntentPlanMappingResult =
  | { ok: true; recommendations: MappedSparkRecommendation[] }
  | {
    ok: false;
    error: {
      code: "unknown-entry-id" | "duplicate-entry-id";
      entryId: string;
    };
  };

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export const BROWSER_SPARK_ERROR = "Reasoning requires the native Operator Key app, which talks to a model you run and configure yourself.";
const MAX_CANDIDATES = 220;
const INTENT_TERM_EXPANSIONS: Readonly<Record<string, readonly string[]>> = {
  check: ["status", "health", "doctor", "diagnose"],
  healthy: ["status", "health", "doctor", "diagnose"],
  health: ["status", "healthy", "doctor", "diagnose"],
  interactive: ["chat", "session", "shell"],
  converse: ["chat", "session"],
  conversation: ["chat", "session"],
};

function clean(value: string): string {
  return value.toLowerCase().trim().replace(/[_–—]/g, "-").replace(/\s+/g, " ");
}

function words(value: string): string[] {
  return clean(value).replace(/^\/+/, "").split(/[^a-z0-9]+/).filter(Boolean);
}

function intentWords(value: string): string[] {
  const terms = words(value);
  return [...new Set(terms.flatMap((term) => [term, ...(INTENT_TERM_EXPANSIONS[term] ?? [])]))];
}

function passesFilters(entry: CatalogEntry, filters: SearchFilters): boolean {
  return (!filters.product || entry.product === filters.product)
    && (!filters.interface || entry.interface === filters.interface)
    && (!filters.task || entry.task_group === filters.task)
    && (!filters.safety || entry.safety_level === filters.safety);
}

function evidenceScore(entry: CatalogEntry, query: string): number | null {
  const normalizedQuery = clean(query);
  const directTerms = words(query);
  const directTermSet = new Set(directTerms);
  const queryTerms = intentWords(query);
  if (!normalizedQuery || queryTerms.length === 0) return null;

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
  if (aliases.includes(normalizedQuery)) score += 10_000;
  if (task === normalizedQuery) score += 10_000;
  if (description === normalizedQuery) score += 1_000;
  if (product === normalizedQuery) score += 100;

  let matched = false;
  for (const term of queryTerms) {
    if (commandWords.has(term)) {
      score += 50_000;
      if (!directTermSet.has(term)) score += 25_000;
      matched = true;
    } else if (aliasWords.has(term) || aliases.some((alias) => alias.includes(term))) {
      score += 4_000;
      matched = true;
    } else if (taskWords.has(term) || task.includes(term)) {
      score += 800;
      matched = true;
    } else if (descriptionWords.has(term) || description.includes(term)) {
      score += 120;
      matched = true;
    } else if (productWords.has(term) || product.includes(term)) {
      score += 20;
      matched = true;
    }
  }

  if (aliases.some((alias) => alias.includes(normalizedQuery))) score += 20_000;
  if (task.includes(normalizedQuery)) score += 2_000;
  if (description.includes(normalizedQuery)) score += 300;
  if (product.includes(normalizedQuery)) score += 40;
  return matched || score > 0 ? score : null;
}

function appendDiverseFallback(
  entries: readonly CatalogEntry[],
  seen: Set<string>,
  ids: string[],
): void {
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    const key = `${entry.product}\u0000${entry.task_group}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }

  const orderedGroups = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => group.sort((left, right) => left.id.localeCompare(right.id)));

  for (let offset = 0; ids.length < MAX_CANDIDATES; offset += 1) {
    let appended = false;
    for (const group of orderedGroups) {
      const entry = group[offset];
      if (!entry || seen.has(entry.id)) continue;
      ids.push(entry.id);
      seen.add(entry.id);
      appended = true;
      if (ids.length === MAX_CANDIDATES) return;
    }
    if (!appended) return;
  }
}

/**
 * Build a deterministic, trusted, provider-bound candidate pool without
 * changing the caller's catalog or exact-result arrays.
 */
export function buildIntentCandidateIds(
  entries: readonly CatalogEntry[],
  query: string,
  filters: SearchFilters = {},
  exactResults: readonly SearchResult[] = [],
): string[] {
  const eligible = entries.filter((entry) => passesFilters(entry, filters));
  const catalogById = new Map<string, CatalogEntry>();
  for (const entry of [...eligible].sort((left, right) => (
    Number(!left.available) - Number(!right.available) || left.id.localeCompare(right.id)
  ))) {
    if (!catalogById.has(entry.id)) catalogById.set(entry.id, entry);
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  const append = (id: string): void => {
    if (ids.length >= MAX_CANDIDATES || seen.has(id) || !catalogById.has(id)) return;
    ids.push(id);
    seen.add(id);
  };

  [...exactResults]
    .filter(({ entry }) => catalogById.has(entry.id))
    .sort((left, right) => {
      const leftEntry = catalogById.get(left.entry.id)!;
      const rightEntry = catalogById.get(right.entry.id)!;
      return Number(!leftEntry.available) - Number(!rightEntry.available)
        || right.score - left.score
        || left.entry.id.localeCompare(right.entry.id);
    })
    .forEach(({ entry }) => append(entry.id));

  const broad = [...catalogById.values()]
    .map((entry) => ({ entry, score: evidenceScore(entry, query) }))
    .filter((candidate): candidate is { entry: CatalogEntry; score: number } => candidate.score !== null)
    .sort((left, right) => Number(!left.entry.available) - Number(!right.entry.available)
      || right.score - left.score
      || left.entry.id.localeCompare(right.entry.id));
  for (const { entry } of broad) append(entry.id);

  const remaining = [...catalogById.values()];
  appendDiverseFallback(remaining.filter((entry) => entry.available), seen, ids);
  appendDiverseFallback(remaining.filter((entry) => !entry.available), seen, ids);
  return ids;
}

export function createNativeIntentReasoner(nativeInvoke: Invoke = invoke): IntentReasoner {
  return {
    async status() {
      return nativeInvoke("spark_intent_status") as Promise<SparkStatus>;
    },
    async reason(intent, candidateIds) {
      return nativeInvoke("reason_about_intent", {
        intent,
        candidateIds: [...candidateIds],
      }) as Promise<SparkIntentPlan>;
    },
  };
}

export function createBrowserIntentReasoner(): IntentReasoner {
  return {
    async status() {
      return {
        available: false,
        loggedIn: false,
        model: "",
        provider: "disabled",
        configPath: "",
        message: BROWSER_SPARK_ERROR,
      };
    },
    async reason() {
      throw new Error(BROWSER_SPARK_ERROR);
    },
  };
}

export function mapIntentPlanEntries(
  plan: SparkIntentPlan,
  entries: readonly CatalogEntry[],
): IntentPlanMappingResult {
  const catalogById = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const recommendations: MappedSparkRecommendation[] = [];

  for (const recommendation of plan.recommendations) {
    if (seen.has(recommendation.entryId)) {
      return { ok: false, error: { code: "duplicate-entry-id", entryId: recommendation.entryId } };
    }
    seen.add(recommendation.entryId);
    const entry = catalogById.get(recommendation.entryId);
    if (!entry) {
      return { ok: false, error: { code: "unknown-entry-id", entryId: recommendation.entryId } };
    }
    recommendations.push({ ...recommendation, entry });
  }

  return { ok: true, recommendations };
}