/**
 * Advisory snapshot of the host's live shortcut environment, as validated on THIS
 * side of the Tauri bridge.
 *
 * The Rust probe already bounds and launders its report, but the bridge is still a
 * process boundary: what arrives here is JSON from another program, and an older or
 * newer native build may disagree with this frontend about the shape. The validator
 * fails closed — any malformed report becomes an honest "unavailable", never a throw
 * and never a half-parsed report rendered as fact.
 *
 * Nothing in this module gates search, copy, or insert. Unknown means unknown.
 */

import { normalizeChord } from "./search";

/** Mirror of the Rust caps: defense in depth, not a protocol. */
const MAX_BINDINGS = 512;
const MAX_CHORD_LEN = 96;
const MAX_DESCRIPTION_LEN = 160;
const MAX_DISPATCHER_LEN = 64;
const MAX_LAYOUTS = 8;
const MAX_LAYOUT_LEN = 48;
const MAX_KEYMAP_LEN = 64;
const MAX_REASON_LEN = 200;

export type ShortcutProbeStatus = "ok" | "unavailable";

export interface ActiveBinding {
  /** Canonical chord in normalizeChord order: ctrl+alt+shift+super+key. */
  readonly chord: string;
  /** Upstream's own description, bounded; empty when the bind has none. */
  readonly description: string;
  /** Dispatcher name only; arguments never cross the bridge. */
  readonly dispatcher: string;
}

export interface KeyboardHints {
  readonly layouts: readonly string[];
  readonly activeKeymap: string | null;
}

export interface ShortcutEnvironmentReport {
  readonly status: ShortcutProbeStatus;
  readonly unavailableReason: string | null;
  readonly bindings: readonly ActiveBinding[];
  readonly truncated: boolean;
  readonly keyboard: KeyboardHints;
}

export const REASON_MALFORMED_REPORT =
  "The native shortcut probe returned an unexpected shape";
export const REASON_PROBE_UNAVAILABLE =
  "This build cannot probe the shortcut environment";

const EMPTY_KEYBOARD: KeyboardHints = Object.freeze({ layouts: [], activeKeymap: null });

/** Before the native side answers — or when there is no native side at all. */
export const UNPROBED_SHORTCUT_ENVIRONMENT: ShortcutEnvironmentReport = Object.freeze({
  status: "unavailable" as const,
  unavailableReason: REASON_PROBE_UNAVAILABLE,
  bindings: [],
  truncated: false,
  keyboard: EMPTY_KEYBOARD,
});

function unavailableReport(reason: string): ShortcutEnvironmentReport {
  return {
    status: "unavailable",
    unavailableReason: reason,
    bindings: [],
    truncated: false,
    keyboard: EMPTY_KEYBOARD,
  };
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  return Array.from(value).slice(0, max).join("");
}

/**
 * Rebuild one binding field-by-field on a null prototype. Returning null rejects the
 * WHOLE report: a probe that emits even one unparseable binding cannot be trusted to
 * describe this machine.
 */
function rebuildBinding(value: unknown): ActiveBinding | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawChord = boundedString(record.chord, MAX_CHORD_LEN);
  const description = boundedString(record.description, MAX_DESCRIPTION_LEN);
  const dispatcher = boundedString(record.dispatcher, MAX_DISPATCHER_LEN);
  if (rawChord === null || description === null || dispatcher === null) return null;
  // Do not TRUST the native side's ordering claim — normalize again here, so a
  // skewed emitter cannot silently break every lookup.
  const chord = normalizeChord(rawChord);
  if (chord.length === 0) return null;
  const binding: ActiveBinding = Object.create(null) as ActiveBinding;
  Object.assign(binding, { chord, description, dispatcher });
  return binding;
}

function rebuildKeyboard(value: unknown): KeyboardHints | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.layouts)) return null;
  const layouts: string[] = [];
  for (const raw of record.layouts) {
    if (typeof raw !== "string") return null;
    const layout = raw.trim().slice(0, MAX_LAYOUT_LEN);
    if (layout.length === 0) continue;
    if (!layouts.includes(layout) && layouts.length < MAX_LAYOUTS) layouts.push(layout);
  }
  let activeKeymap: string | null = null;
  if (record.activeKeymap !== null && record.activeKeymap !== undefined) {
    const keymap = boundedString(record.activeKeymap, MAX_KEYMAP_LEN);
    if (keymap === null) return null;
    activeKeymap = keymap.trim().length === 0 ? null : keymap;
  }
  return { layouts, activeKeymap };
}

/** Validate a report from the bridge. Fails closed to "unavailable"; never throws. */
export function parseShortcutEnvironment(value: unknown): ShortcutEnvironmentReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return unavailableReport(REASON_MALFORMED_REPORT);
  }
  const record = value as Record<string, unknown>;
  if (record.status === "unavailable") {
    const reason = boundedString(record.unavailableReason, MAX_REASON_LEN);
    return unavailableReport(
      reason !== null && reason.trim().length > 0 ? reason : REASON_MALFORMED_REPORT,
    );
  }
  if (record.status !== "ok") return unavailableReport(REASON_MALFORMED_REPORT);
  if (!Array.isArray(record.bindings) || typeof record.truncated !== "boolean") {
    return unavailableReport(REASON_MALFORMED_REPORT);
  }
  const keyboard = rebuildKeyboard(record.keyboard);
  if (keyboard === null) return unavailableReport(REASON_MALFORMED_REPORT);
  const bindings: ActiveBinding[] = [];
  let truncated = record.truncated;
  for (const raw of record.bindings) {
    const binding = rebuildBinding(raw);
    if (binding === null) return unavailableReport(REASON_MALFORMED_REPORT);
    if (bindings.length === MAX_BINDINGS) {
      truncated = true;
      break;
    }
    bindings.push(binding);
  }
  return { status: "ok", unavailableReason: null, bindings, truncated, keyboard };
}

/**
 * Every active binding matching a chord, after normalizing the query. Empty for
 * blank queries and non-ok reports — an unavailable probe has no opinion, and
 * callers must not read "no hits" as "not bound".
 */
export function lookupActiveBindings(
  report: ShortcutEnvironmentReport,
  chordQuery: string,
): readonly ActiveBinding[] {
  if (report.status !== "ok") return [];
  if (chordQuery.trim().length === 0) return [];
  const chord = normalizeChord(chordQuery);
  if (chord.length === 0) return [];
  return report.bindings.filter((binding) => binding.chord === chord);
}
