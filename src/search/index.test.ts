import catalogJson from "../../data/catalog.json";
import { describe, expect, it } from "vitest";
import { parseCatalog } from "../catalog";
import { createSearchIndex, normalizeChord, searchCatalog } from ".";

const catalogResult = parseCatalog(catalogJson);
if (!catalogResult.ok) throw new Error(catalogResult.error);
const entries = catalogResult.catalog.entries;
const index = createSearchIndex(entries);

function exhaustiveCandidates(query: string) {
  const allRecordIndexes = index.records.map((_, recordIndex) => recordIndex);
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const candidateKeys = new Set(terms.flatMap((term) => {
    const trigrams: string[] = [];
    for (let start = 0; start <= term.length - 3; start += 1) trigrams.push(term.slice(start, start + 3));
    return term.length <= 3 ? [term] : trigrams;
  }));
  return {
    ...index,
    termPostings: new Map([...candidateKeys].map((term) => [term, allRecordIndexes])),
  };
}

describe("intent search", () => {
  it("ranks exact command above alias, task, description, and product matches", () => {
    const fixture = [
      { ...entries[0], id: "product", product: "hermes" as const, command: "product-only", aliases: [], task_group: "development" as const, description: "other" },
      { ...entries[0], id: "description", product: "omarchy" as const, command: "desc", aliases: [], task_group: "development" as const, description: "Hermes" },
      { ...entries[0], id: "alias", product: "omarchy" as const, command: "alias", aliases: ["hermes"], task_group: "development" as const, description: "other" },
      { ...entries[0], id: "command", product: "omarchy" as const, command: "hermes", aliases: [], task_group: "development" as const, description: "other" },
    ];
    expect(searchCatalog(createSearchIndex(fixture), "hermes").map(({ entry }) => entry.id)).toEqual([
      "command", "alias", "description", "product",
    ]);

    const taskFixture = [
      { ...entries[0], id: "task", command: "task", aliases: [], task_group: "review-and-verify" as const, description: "other" },
      { ...entries[0], id: "description", command: "description", aliases: [], task_group: "development" as const, description: "review" },
    ];
    expect(searchCatalog(createSearchIndex(taskFixture), "review").map(({ entry }) => entry.id)).toEqual(["task", "description"]);
  });

  it("requires every query term to be meaningful", () => {
    const results = searchCatalog(index, "review code");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.command).toBe("/code-review");
    expect(results.every((result) => result.matchedTerms.length === 2)).toBe(true);
  });

  it("finds resume-session intent and move-window intent", () => {
    expect(searchCatalog(index, "resume session")[0].entry.command.toLowerCase()).toContain("resume");
    const moved = searchCatalog(index, "move window", { product: "omarchy" });
    expect(moved[0].entry.description.toLowerCase()).toContain("move window");
  });

  it("normalizes reverse chord modifier order and finds conflicts", () => {
    expect(normalizeChord("SHIFT CTRL B")).toBe("ctrl+shift+b");
    const results = searchCatalog(index, "Ctrl+B");
    expect(results.slice(0, 2).map(({ entry }) => entry.product)).toEqual(["hermes", "claude-code"]);
    expect(results.slice(0, 2).every(({ entry }) => entry.conflict_ids.length > 0)).toBe(true);
  });

  it("falls back to indexed text matching when modifier words are not a known chord", () => {
    const fixture = [{
      ...entries[0],
      id: "control-panel",
      command: "open control panel",
      aliases: [],
      description: "Open the control panel",
    }];
    expect(searchCatalog(createSearchIndex(fixture), "control panel")[0].entry.id).toBe("control-panel");
  });

  it("filters by product, interface, task, and safety", () => {
    const results = searchCatalog(index, "move window", {
      product: "omarchy",
      interface: "hotkey",
      task: "sessions-and-navigation",
      safety: "amber",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(({ entry }) => entry.product === "omarchy" && entry.interface === "hotkey" && entry.task_group === "sessions-and-navigation" && entry.safety_level === "amber")).toBe(true);
    expect(searchCatalog(index, "move window", { safety: "green" })).toEqual([]);
  });

  it("returns no results when no entry makes every term meaningful", () => {
    expect(searchCatalog(index, "zirconium impossible operator phrase")).toEqual([]);
  });

  it("demotes unavailable rows with stable ID tie-breaking", () => {
    const base = { ...entries[0], command: "same", canonical_chord: "", aliases: [], description: "same", product: "hermes" as const };
    const results = searchCatalog(createSearchIndex([
      { ...base, id: "a-unavailable", available: false },
      { ...base, id: "c-available", available: true },
      { ...base, id: "b-available", available: true },
    ]), "same");
    expect(results.map(({ entry }) => entry.id)).toEqual(["b-available", "c-available", "a-unavailable"]);
    expect(results[2].unavailable).toBe(true);
  });

  it("normalizes catalog fields once and reuses the built index across queries", () => {
    let aliasReads = 0;
    const tracked = { ...entries[0] };
    Object.defineProperty(tracked, "aliases", {
      enumerable: true,
      get: () => {
        aliasReads += 1;
        if (aliasReads > 1) throw new Error("aliases were normalized again");
        return ["tracked intent"];
      },
    });

    const reusableIndex = createSearchIndex([tracked]);
    expect(searchCatalog(reusableIndex, "tracked")[0].entry.id).toBe(tracked.id);
    expect(searchCatalog(reusableIndex, tracked.command)[0].entry.id).toBe(tracked.id);
    expect(aliasReads).toBe(1);
  });

  it("preserves arbitrary substring matches and ranking with bounded candidates", () => {
    for (const query of ["eview", "indow", "ssion", "ermes", "code revi", "avig sess"]) {
      const bounded = searchCatalog(index, query, {}, 50);
      const exhaustive = searchCatalog(exhaustiveCandidates(query), query, {}, 50);
      expect(bounded.map(({ entry, score }) => [entry.id, score])).toEqual(
        exhaustive.map(({ entry, score }) => [entry.id, score]),
      );
    }
  });

  it("bounds index growth to exact tokens plus unigrams, bigrams, and trigrams", () => {
    const started = performance.now();
    const boundedIndex = createSearchIndex(entries);
    const elapsed = performance.now() - started;
    const postingReferences = [...boundedIndex.termPostings.values()]
      .reduce((total, postings) => total + postings.length, 0);
    const gramBudget = entries.reduce((total, entry) => {
      const tokens = new Set([
        entry.command,
        ...entry.aliases,
        entry.task_group,
        entry.description,
        entry.product,
      ].flatMap((value) => value.toLowerCase().replace(/^\/+/, "").split(/[^a-z0-9]+/).filter(Boolean)));
      return total + [...tokens].reduce((tokenTotal, token) => (
        tokenTotal + 1 + token.length + Math.max(0, token.length - 1) + Math.max(0, token.length - 2)
      ), 0);
    }, 0);

    expect(entries.length).toBeGreaterThan(0);
    expect(postingReferences).toBeLessThanOrEqual(gramBudget);
    expect(elapsed).toBeLessThan(500);
  });

  it("returns top results from the precomputed full-catalog index under 50ms", () => {
    const started = performance.now();
    const results = searchCatalog(index, "review code", {}, 24);
    const elapsed = performance.now() - started;
    expect(entries.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(24);
    expect(elapsed).toBeLessThan(50);
  });
});
