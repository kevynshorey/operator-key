import { describe, expect, it } from "vitest";
import catalogJson from "../../data/catalog.json";
import { parseCatalog, type CatalogEntry } from "../catalog";
import { createSearchIndex, searchCatalog } from "./index";
import { createPredictionIndex, predictIntent } from "../predict";

/**
 * Regression cover for the natural-language gap: the field invites a full sentence,
 * so a full sentence must never return an empty screen or letter-matched noise.
 */
function entries(): CatalogEntry[] {
  const parsed = parseCatalog(catalogJson);
  if (!parsed.ok) throw new Error("catalog must parse");
  return [...parsed.catalog.entries];
}

const catalogEntries = entries();
const searchIndex = createSearchIndex(catalogEntries);
const predictionIndex = createPredictionIndex(catalogEntries);

describe("natural language intent", () => {
  const sentences = [
    "review my code",
    "I want to review my code",
    "how do I review my code",
    "check the security of my code",
    "commit my changes",
    "show me how to resume a session",
    "I need to see my session history",
  ];

  for (const sentence of sentences) {
    it(`returns results for "${sentence}"`, () => {
      const results = searchCatalog(searchIndex, sentence);
      expect(results.length).toBeGreaterThan(0);
    });
  }

  it("keeps filler words from vetoing a match", () => {
    const bare = searchCatalog(searchIndex, "review code");
    const prose = searchCatalog(searchIndex, "I want to review my code");
    expect(prose.length).toBeGreaterThan(0);
    // The prose form must find the same leading command as the terse form.
    expect(prose[0].entry.id).toBe(bare[0].entry.id);
  });

  it("does not let a stopword-only query collapse to everything", () => {
    const results = searchCatalog(searchIndex, "the");
    // "the" is a stopword, but as the whole query it must still behave as a search,
    // not silently match every record with a zero score.
    expect(results.length).toBeLessThan(catalogEntries.length);
  });

  it("still honours exact command lookups", () => {
    // Use a command that genuinely exists in the shipped catalog rather than assuming one,
    // so this test tracks the data instead of a guess.
    const sample = catalogEntries.find((entry) => entry.interface !== "hotkey" && entry.command.length > 4);
    expect(sample).toBeDefined();
    const results = searchCatalog(searchIndex, sample!.command);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(1_000);
  });

  it("respects filters while relaxing terms", () => {
    const results = searchCatalog(searchIndex, "I want to review my code", { product: "hermes" });
    for (const result of results) expect(result.entry.product).toBe("hermes");
  });

  it("suggests a meaningful intent for prose that is not a prefix", () => {
    const suggestions = predictIntent(predictionIndex, "review my code");
    expect(suggestions.length).toBeGreaterThan(0);
    // At least one suggestion must be a real catalog phrase rather than a letter-extension
    // of the typed text (the old behaviour produced "review my codex").
    const intentSuggestions = suggestions.filter((item) => item.kind === "intent");
    expect(intentSuggestions.length).toBeGreaterThan(0);
    for (const suggestion of intentSuggestions) {
      expect(suggestion.completion).not.toMatch(/^review my code./);
    }
  });

  it("never proposes ghost text that is not a true prefix", () => {
    for (const sentence of sentences) {
      for (const suggestion of predictIntent(predictionIndex, sentence)) {
        if (!suggestion.ghost) continue;
        expect(suggestion.completion.startsWith(sentence)).toBe(true);
      }
    }
  });
});
