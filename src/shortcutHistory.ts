/**
 * Shortcut history ledger: explaining where a binding WENT, without ever implying the
 * old binding still works.
 *
 * The catalog states what is bound NOW on the version it was generated from. When an
 * operator reaches for a chord that upstream retired — SUPER + A for ChatGPT, moved in
 * Omarchy 3.1.0 — exact-only reverse lookup (src/search) correctly returns nothing, and
 * "no matching command" is true but unhelpful: the operator's memory isn't wrong, it's
 * out of date, and the difference matters.
 *
 * This ledger is versioned, source-backed data (`data/shortcut-history.json`), not
 * detection: every entry carries the last release that shipped the old chord, the first
 * that shipped the new one, and exact upstream commit/tag URLs. Anything malformed is
 * rejected whole — advisory history must never be able to take the app down or smuggle
 * a fabricated citation. Rendering must always label these as historical/advisory.
 */

import { PRODUCTS, type Product } from "./catalog";
import { normalizeChord } from "./search";

export interface ShortcutMove {
  readonly product: Product;
  /** What the binding launches/does — display text, e.g. "ChatGPT web app". */
  readonly description: string;
  /** Canonical retired chord (normalizeChord form). */
  readonly old_chord: string;
  /** Canonical chord that replaced it. */
  readonly current_chord: string;
  /** Last upstream release that still shipped old_chord. */
  readonly last_version_with_old: string;
  /** First upstream release that shipped current_chord. */
  readonly first_version_with_new: string;
  /** Exact upstream provenance: commit and/or release-tag URLs. https GitHub only. */
  readonly sources: readonly string[];
}

export interface ShortcutHistory {
  readonly schema_version: string;
  readonly entries: readonly ShortcutMove[];
}

function isPlainString(value: unknown): value is string {
  // A boxed String survives typeof checks in some validators and then breaks
  // callers that assume primitive behavior; require the primitive.
  return typeof value === "string" && value.trim().length > 0;
}

const VERSION_SHAPE = /^\d+(?:\.\d+)*$/;

function parseMove(value: unknown): ShortcutMove | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const product = record.product;
  if (!isPlainString(product) || !(PRODUCTS as readonly string[]).includes(product)) return undefined;
  const description = record.description;
  const oldChord = record.old_chord;
  const currentChord = record.current_chord;
  const lastOld = record.last_version_with_old;
  const firstNew = record.first_version_with_new;
  const sources = record.sources;
  if (!isPlainString(description)) return undefined;
  if (!isPlainString(oldChord) || !isPlainString(currentChord)) return undefined;
  if (normalizeChord(oldChord) !== oldChord || normalizeChord(currentChord) !== currentChord) return undefined;
  // A "move" whose chords are identical is a data error that would render as nonsense.
  if (oldChord === currentChord) return undefined;
  if (!isPlainString(lastOld) || !VERSION_SHAPE.test(lastOld)) return undefined;
  if (!isPlainString(firstNew) || !VERSION_SHAPE.test(firstNew)) return undefined;
  if (!Array.isArray(sources) || sources.length === 0) return undefined;
  if (!sources.every((url) => isPlainString(url) && url.startsWith("https://github.com/"))) return undefined;
  // Rebuild field-by-field: never pass the parsed object through, so an extra key
  // (including "__proto__") can never ride into the app.
  const move = Object.create(null) as {
    product: Product; description: string; old_chord: string; current_chord: string;
    last_version_with_old: string; first_version_with_new: string; sources: readonly string[];
  };
  move.product = product as Product;
  move.description = description.trim();
  move.old_chord = oldChord;
  move.current_chord = currentChord;
  move.last_version_with_old = lastOld;
  move.first_version_with_new = firstNew;
  move.sources = Object.freeze(sources.slice());
  return Object.freeze(move) as ShortcutMove;
}

/** Validate the whole ledger; any invalid entry rejects the file (fail closed). */
export function parseShortcutHistory(value: unknown): ShortcutHistory | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isPlainString(record.schema_version)) return undefined;
  if (!Array.isArray(record.entries)) return undefined;
  const entries: ShortcutMove[] = [];
  for (const raw of record.entries) {
    const move = parseMove(raw);
    if (!move) return undefined;
    entries.push(move);
  }
  return Object.freeze({ schema_version: record.schema_version, entries: Object.freeze(entries) });
}

/**
 * Every recorded move touching this chord for this product, matching either side:
 * someone searching the retired chord learns where it went; someone searching the
 * current chord learns it used to live elsewhere.
 */
export function lookupChordHistory(
  history: ShortcutHistory,
  chord: string,
  product?: Product,
): readonly ShortcutMove[] {
  const canonical = normalizeChord(chord);
  if (!canonical) return [];
  return history.entries.filter((move) =>
    (move.old_chord === canonical || move.current_chord === canonical)
    && (!product || move.product === product));
}
