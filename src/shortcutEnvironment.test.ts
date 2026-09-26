import { describe, expect, it } from "vitest";
import {
  UNPROBED_SHORTCUT_ENVIRONMENT,
  lookupActiveBindings,
  parseShortcutEnvironment,
} from "./shortcutEnvironment";
import { readShortcutEnvironment } from "./actions";

/**
 * The native probe crosses a trust boundary: whatever crosses the Tauri bridge is
 * JSON from another process. The validator must fail closed to "unavailable" —
 * never throw into the UI, never render a half-parsed report as fact.
 */

function validReport(): Record<string, unknown> {
  return {
    status: "ok",
    unavailableReason: null,
    bindings: [
      { chord: "shift+super+a", description: "ChatGPT", dispatcher: "exec" },
      { chord: "super+return", description: "Terminal", dispatcher: "exec" },
    ],
    truncated: false,
    keyboard: { layouts: ["us", "gb"], activeKeymap: "English (UK)" },
  };
}

describe("parseShortcutEnvironment", () => {
  it("accepts a valid ok report", () => {
    const report = parseShortcutEnvironment(validReport());
    expect(report.status).toBe("ok");
    expect(report.bindings).toHaveLength(2);
    expect(report.bindings[0]).toEqual({
      chord: "shift+super+a",
      description: "ChatGPT",
      dispatcher: "exec",
    });
    expect(report.keyboard.layouts).toEqual(["us", "gb"]);
    expect(report.keyboard.activeKeymap).toBe("English (UK)");
    expect(report.truncated).toBe(false);
  });

  it("accepts a valid unavailable report and carries its fixed reason", () => {
    const report = parseShortcutEnvironment({
      status: "unavailable",
      unavailableReason: "Shortcut probing needs hyprctl on PATH",
      bindings: [],
      truncated: false,
      keyboard: { layouts: [], activeKeymap: null },
    });
    expect(report.status).toBe("unavailable");
    expect(report.unavailableReason).toBe("Shortcut probing needs hyprctl on PATH");
    expect(report.bindings).toEqual([]);
  });

  it("fails closed to unavailable on malformed shapes instead of throwing", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "ok",
      [],
      {},
      { status: "weird", bindings: [], truncated: false, keyboard: { layouts: [], activeKeymap: null } },
      { ...validReport(), bindings: "not-an-array" },
      { ...validReport(), truncated: "yes" },
      { ...validReport(), keyboard: null },
    ]) {
      const report = parseShortcutEnvironment(bad);
      expect(report.status).toBe("unavailable");
      expect(report.bindings).toEqual([]);
    }
  });

  it("rejects the whole report when any single binding is malformed", () => {
    // A report that is half-lie is worse than no report: one unparseable binding
    // means the probe cannot be trusted to describe this machine.
    const poisoned = validReport();
    (poisoned.bindings as unknown[]).push({ chord: 7, description: "x", dispatcher: "exec" });
    const report = parseShortcutEnvironment(poisoned);
    expect(report.status).toBe("unavailable");
    expect(report.bindings).toEqual([]);
  });

  it("rebuilds records instead of passing parsed objects through", () => {
    const smuggling = validReport();
    (smuggling.bindings as Record<string, unknown>[])[0].extra = "field";
    (smuggling as Record<string, unknown>).bonus = "top-level";
    const report = parseShortcutEnvironment(smuggling);
    expect(report.status).toBe("ok");
    expect(Object.keys(report)).toEqual([
      "status",
      "unavailableReason",
      "bindings",
      "truncated",
      "keyboard",
    ]);
    expect(Object.keys(report.bindings[0])).toEqual(["chord", "description", "dispatcher"]);
    expect(Object.getPrototypeOf(report.bindings[0])).toBe(null);
  });

  it("bounds binding count and string lengths defensively on this side too", () => {
    const flooded = validReport();
    flooded.bindings = Array.from({ length: 700 }, (_, index) => ({
      chord: `super+f${index}`,
      description: "d".repeat(5000),
      dispatcher: "e".repeat(500),
    }));
    const report = parseShortcutEnvironment(flooded);
    expect(report.status).toBe("ok");
    expect(report.bindings.length).toBeLessThanOrEqual(512);
    expect(report.truncated).toBe(true);
    expect(report.bindings[0].description.length).toBeLessThanOrEqual(160);
    expect(report.bindings[0].dispatcher.length).toBeLessThanOrEqual(64);
  });

  it("normalizes reported chords through the frontend normalizer", () => {
    // The Rust side already emits canonical order, but the validator must not
    // TRUST that: a skewed order would silently break lookups.
    const skewed = validReport();
    (skewed.bindings as Record<string, unknown>[])[0] = {
      chord: "SUPER+SHIFT+A",
      description: "ChatGPT",
      dispatcher: "exec",
    };
    const report = parseShortcutEnvironment(skewed);
    expect(report.bindings[0].chord).toBe("shift+super+a");
  });

  it("drops empty layouts, dedupes, and bounds keyboard hints", () => {
    const noisy = validReport();
    noisy.keyboard = {
      layouts: ["us", "us", "", "  ", "gb", ...Array.from({ length: 20 }, (_, i) => `l${i}`)],
      activeKeymap: "k".repeat(500),
    };
    const report = parseShortcutEnvironment(noisy);
    expect(report.keyboard.layouts.slice(0, 2)).toEqual(["us", "gb"]);
    expect(report.keyboard.layouts.length).toBeLessThanOrEqual(8);
    expect((report.keyboard.activeKeymap ?? "").length).toBeLessThanOrEqual(64);
  });
});

describe("lookupActiveBindings", () => {
  it("finds bindings for a canonical chord", () => {
    const report = parseShortcutEnvironment(validReport());
    const hits = lookupActiveBindings(report, "shift+super+a");
    expect(hits).toHaveLength(1);
    expect(hits[0].description).toBe("ChatGPT");
  });

  it("normalizes the queried chord before matching", () => {
    const report = parseShortcutEnvironment(validReport());
    expect(lookupActiveBindings(report, "SUPER + SHIFT + A")).toHaveLength(1);
    expect(lookupActiveBindings(report, "⇧⌘A".replace("⌘", "super+"))).toBeDefined();
  });

  it("returns nothing from an unavailable or unprobed report", () => {
    expect(lookupActiveBindings(UNPROBED_SHORTCUT_ENVIRONMENT, "shift+super+a")).toEqual([]);
    const unavailable = parseShortcutEnvironment(null);
    expect(lookupActiveBindings(unavailable, "shift+super+a")).toEqual([]);
    // Defense in depth: even a hand-built contradictory report (unavailable, yet
    // carrying bindings) must answer nothing. The status check is the contract,
    // not an accident of unavailable reports happening to be empty.
    const contradictory = {
      status: "unavailable" as const,
      unavailableReason: "probe failed",
      bindings: [{ chord: "shift+super+a", description: "ChatGPT", dispatcher: "exec" }],
      truncated: false,
      keyboard: { layouts: [], activeKeymap: null },
    };
    expect(lookupActiveBindings(contradictory, "shift+super+a")).toEqual([]);
  });

  it("returns nothing for blank queries instead of matching everything", () => {
    const report = parseShortcutEnvironment(validReport());
    expect(lookupActiveBindings(report, "")).toEqual([]);
    expect(lookupActiveBindings(report, "   ")).toEqual([]);
  });
});

describe("readShortcutEnvironment", () => {
  it("returns the validated report from a healthy native answer", async () => {
    const report = await readShortcutEnvironment(async <T,>() => validReport() as T);
    expect(report.status).toBe("ok");
    expect(report.bindings).toHaveLength(2);
  });

  it("degrades to unprobed when the command is missing (older native build)", async () => {
    const report = await readShortcutEnvironment(async () => {
      throw new Error("command shortcut_environment not found");
    });
    expect(report).toEqual(UNPROBED_SHORTCUT_ENVIRONMENT);
  });

  it("fails closed when the native answer is malformed", async () => {
    const report = await readShortcutEnvironment(async <T,>() => ({ status: "ok" }) as T);
    expect(report.status).toBe("unavailable");
    expect(report.bindings).toEqual([]);
  });
});
