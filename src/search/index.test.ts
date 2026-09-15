import catalogJson from "../../data/catalog.json";
import { describe, expect, it } from "vitest";
import { parseCatalog } from "../catalog";
import { normalizeChord, searchCatalog } from ".";

const catalogResult = parseCatalog(catalogJson);
if (!catalogResult.ok) throw new Error(catalogResult.error);
const entries = catalogResult.catalog.entries;

describe("intent search", () => {
  it("ranks exact command above alias, task, description, and product matches", () => {
    const fixture = [
      { ...entries[0], id: "product", product: "hermes" as const, command: "product-only", aliases: [], task_group: "development" as const, description: "other" },
      { ...entries[0], id: "description", product: "omarchy" as const, command: "desc", aliases: [], task_group: "development" as const, description: "Hermes" },
      { ...entries[0], id: "alias", product: "omarchy" as const, command: "alias", aliases: ["hermes"], task_group: "development" as const, description: "other" },
      { ...entries[0], id: "command", product: "omarchy" as const, command: "hermes", aliases: [], task_group: "development" as const, description: "other" },
    ];
    expect(searchCatalog(fixture, "hermes").map(({ entry }) => entry.id)).toEqual([
      "command", "alias", "description", "product",
    ]);

    const taskFixture = [
      { ...entries[0], id: "task", command: "task", aliases: [], task_group: "review-and-verify" as const, description: "other" },
      { ...entries[0], id: "description", command: "description", aliases: [], task_group: "development" as const, description: "review" },
    ];
    expect(searchCatalog(taskFixture, "review").map(({ entry }) => entry.id)).toEqual(["task", "description"]);
  });

  it("requires every query term to be meaningful", () => {
    const results = searchCatalog(entries, "review code");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.command).toBe("/code-review");
    expect(results.every((result) => result.matchedTerms.length === 2)).toBe(true);
  });

  it("finds resume-session intent and move-window intent", () => {
    expect(searchCatalog(entries, "resume session")[0].entry.command.toLowerCase()).toContain("resume");
    const moved = searchCatalog(entries, "move window", { product: "omarchy" });
    expect(moved[0].entry.description.toLowerCase()).toContain("move window");
  });

  it("normalizes reverse chord modifier order and finds conflicts", () => {
    expect(normalizeChord("SHIFT CTRL B")).toBe("ctrl+shift+b");
    const results = searchCatalog(entries, "Ctrl+B");
    expect(results.slice(0, 2).map(({ entry }) => entry.product)).toEqual(["hermes", "claude-code"]);
    expect(results.slice(0, 2).every(({ entry }) => entry.conflict_ids.length > 0)).toBe(true);
  });

  it("filters by product, interface, task, and safety", () => {
    const results = searchCatalog(entries, "move window", {
      product: "omarchy",
      interface: "hotkey",
      task: "sessions-and-navigation",
      safety: "amber",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(({ entry }) => entry.product === "omarchy" && entry.interface === "hotkey" && entry.task_group === "sessions-and-navigation" && entry.safety_level === "amber")).toBe(true);
    expect(searchCatalog(entries, "move window", { safety: "green" })).toEqual([]);
  });

  it("returns no results when no entry makes every term meaningful", () => {
    expect(searchCatalog(entries, "zirconium impossible operator phrase")).toEqual([]);
  });

  it("demotes unavailable rows with stable ID tie-breaking", () => {
    const base = { ...entries[0], command: "same", canonical_chord: "", aliases: [], description: "same", product: "hermes" as const };
    const results = searchCatalog([
      { ...base, id: "a-unavailable", available: false },
      { ...base, id: "c-available", available: true },
      { ...base, id: "b-available", available: true },
    ], "same");
    expect(results.map(({ entry }) => entry.id)).toEqual(["b-available", "c-available", "a-unavailable"]);
    expect(results[2].unavailable).toBe(true);
  });

  it("returns top results for all 1,302 records under 50ms", () => {
    const started = performance.now();
    const results = searchCatalog(entries, "review code", {}, 24);
    const elapsed = performance.now() - started;
    expect(entries).toHaveLength(1302);
    expect(results.length).toBeLessThanOrEqual(24);
    expect(elapsed).toBeLessThan(50);
  });
});
