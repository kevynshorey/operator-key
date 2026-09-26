import { describe, expect, it } from "vitest";
import historyJson from "../data/shortcut-history.json";
import { lookupChordHistory, parseShortcutHistory } from "./shortcutHistory";

describe("shortcut history ledger data", () => {
  it("parses the shipped ledger", () => {
    const ledger = parseShortcutHistory(historyJson);
    expect(ledger).toBeDefined();
    expect(ledger!.entries.length).toBeGreaterThan(0);
  });

  it("records the Omarchy ChatGPT move away from SUPER + A with upstream provenance", () => {
    const ledger = parseShortcutHistory(historyJson)!;
    const moves = lookupChordHistory(ledger, "super+a", "omarchy");
    expect(moves).toHaveLength(1);
    const move = moves[0];
    expect(move.current_chord).toBe("shift+super+a");
    expect(move.description).toMatch(/ChatGPT/);
    // Bounded version range: last release with the old chord, first with the new.
    expect(move.last_version_with_old).toBe("3.0.2");
    expect(move.first_version_with_new).toBe("3.1.0");
    // Exact upstream provenance, not prose.
    expect(move.sources.some((url) => url.includes("fcae2e9809a83cafa5e267934ca9cea28a3686b8"))).toBe(true);
    expect(move.sources.some((url) => url.includes("/releases/tag/v3.1.0"))).toBe(true);
    expect(move.sources.every((url) => url.startsWith("https://github.com/"))).toBe(true);
  });

  it("finds the same move when asked about the new chord", () => {
    const ledger = parseShortcutHistory(historyJson)!;
    const moves = lookupChordHistory(ledger, "shift+super+a", "omarchy");
    expect(moves).toHaveLength(1);
    expect(moves[0].old_chord).toBe("super+a");
  });

  it("returns nothing for a chord with no recorded history", () => {
    const ledger = parseShortcutHistory(historyJson)!;
    expect(lookupChordHistory(ledger, "super+q", "omarchy")).toEqual([]);
  });

  it("scopes lookups by product", () => {
    const ledger = parseShortcutHistory(historyJson)!;
    expect(lookupChordHistory(ledger, "super+a", "git")).toEqual([]);
  });
});

describe("shortcut history validation fails closed", () => {
  const valid = {
    schema_version: "1.0.0",
    entries: [{
      product: "omarchy",
      description: "ChatGPT",
      old_chord: "super+a",
      current_chord: "shift+super+a",
      last_version_with_old: "3.0.2",
      first_version_with_new: "3.1.0",
      sources: ["https://github.com/omacom/omarchy/commit/abc"],
    }],
  };

  it("accepts the reference shape", () => {
    expect(parseShortcutHistory(valid)).toBeDefined();
  });

  const hostile: [string, unknown][] = [
    ["null", null],
    ["array envelope", []],
    ["missing entries", { schema_version: "1.0.0" }],
    ["entries not an array", { ...valid, entries: {} }],
    ["entry missing chord", { ...valid, entries: [{ ...valid.entries[0], old_chord: undefined }] }],
    ["entry with empty description", { ...valid, entries: [{ ...valid.entries[0], description: " " }] }],
    ["non-https source", { ...valid, entries: [{ ...valid.entries[0], sources: ["http://example.com"] }] }],
    ["empty sources", { ...valid, entries: [{ ...valid.entries[0], sources: [] }] }],
    ["identical chords", { ...valid, entries: [{ ...valid.entries[0], current_chord: "super+a" }] }],
    ["boxed string chord", { ...valid, entries: [{ ...valid.entries[0], old_chord: new String("super+a") }] }],
    ["unknown product", { ...valid, entries: [{ ...valid.entries[0], product: "notepad" }] }],
  ];

  for (const [label, value] of hostile) {
    it(`rejects ${label}`, () => {
      expect(parseShortcutHistory(value)).toBeUndefined();
    });
  }

  it("strips unknown fields instead of passing the parsed object through", () => {
    // The move must be REBUILT field-by-field. If the raw record is ever returned
    // directly, extra keys (a smuggled flag, a "__proto__" own-property, a stale
    // field a future renderer trusts) ride into the app unvalidated.
    const poisoned = JSON.parse(`{
      "schema_version": "1.0.0",
      "entries": [{
        "product": "omarchy",
        "description": "ChatGPT",
        "old_chord": "super+a",
        "current_chord": "shift+super+a",
        "last_version_with_old": "3.0.2",
        "first_version_with_new": "3.1.0",
        "sources": ["https://github.com/omacom/omarchy/commit/abc"],
        "polluted": true,
        "__proto__": { "alsoPolluted": true }
      }]
    }`);
    const ledger = parseShortcutHistory(poisoned);
    expect(ledger).toBeDefined();
    const move = lookupChordHistory(ledger!, "super+a", "omarchy")[0] as unknown as Record<string, unknown>;
    expect(move.polluted).toBeUndefined();
    expect(move.alsoPolluted).toBeUndefined();
    expect(Object.keys(move).sort()).toEqual([
      "current_chord", "description", "first_version_with_new",
      "last_version_with_old", "old_chord", "product", "sources",
    ]);
    expect(({} as Record<string, unknown>).alsoPolluted).toBeUndefined();
  });

  it("normalizes chord spellings on lookup rather than requiring canonical input", () => {
    const ledger = parseShortcutHistory(valid)!;
    expect(lookupChordHistory(ledger, "SUPER + A", "omarchy")).toHaveLength(1);
    expect(lookupChordHistory(ledger, "⌘ ⇧ A", "omarchy")).toHaveLength(1);
  });
});
