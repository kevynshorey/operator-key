import { describe, expect, it } from "vitest";
import catalogJson from "../data/catalog.json";
import { parseCatalog, type CatalogEntry } from "./catalog";
import { createPredictionIndex, predictIntent, starterPrompts } from "./predict";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "test-1",
    product: "hermes",
    product_version: "0.21.3",
    interface: "shell-command",
    task_group: "sessions-and-navigation",
    category: "sessions",
    command: "hermes sessions list",
    canonical_chord: "",
    aliases: [],
    description: "list recent sessions",
    context: "Terminal",
    safety_level: "green",
    destructive: false,
    available: true,
    conflict_ids: [],
    source: "local",
    provenance: { kind: "default", status: "active", source: "local", version: "0.21.3" },
    ...overrides,
  };
}

const realCatalog = parseCatalog(catalogJson);

describe("createPredictionIndex", () => {
  it("builds phrase, unigram and bigram models from catalog text", () => {
    const index = createPredictionIndex([entry()]);
    expect(index.phrases.has("list recent sessions")).toBe(true);
    expect(index.unigrams.has("recent")).toBe(true);
    expect(index.bigrams.get("list")?.has("recent")).toBe(true);
  });

  it("weights available entries above unavailable ones", () => {
    const available = createPredictionIndex([entry({ available: true })]);
    const unavailable = createPredictionIndex([entry({ id: "t2", available: false })]);
    expect(available.phrases.get("list recent sessions")!)
      .toBeGreaterThan(unavailable.phrases.get("list recent sessions")!);
  });

  it("excludes hotkey chords from the phrase model", () => {
    const index = createPredictionIndex([
      entry({ interface: "hotkey", command: "SUPER + K", description: "keybindings" }),
    ]);
    expect(index.phrases.has("super k")).toBe(false);
    expect(index.phrases.has("keybindings")).toBe(true);
  });

  it("never suggests stop words on their own", () => {
    const index = createPredictionIndex([entry({ description: "the session" })]);
    expect(index.unigrams.has("the")).toBe(false);
    expect(index.unigrams.has("session")).toBe(true);
  });
});

describe("predictIntent", () => {
  const index = createPredictionIndex([
    entry({ id: "a", description: "resume a previous session" }),
    entry({ id: "b", description: "resume the most recent session" }),
    entry({ id: "c", description: "review pull request changes" }),
  ]);

  it("returns nothing for an empty query", () => {
    expect(predictIntent(index, "")).toEqual([]);
    expect(predictIntent(index, "   ")).toEqual([]);
  });

  it("completes the word being typed when no whole phrase starts with the query", () => {
    const suggestions = predictIntent(index, "check sess");
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect(suggestion.kind).toBe("completion");
      expect(suggestion.completion.startsWith("check sess")).toBe(true);
    }
    // Ranked by catalog frequency: "sessions" outweighs "session" in this fixture.
    expect(suggestions[0].completion).toBe("check sessions");
    expect(suggestions[0].ghost).toBe("ions");
    expect(suggestions.map((item) => item.completion)).toContain("check session");
  });

  it("prefers finishing the whole intent over finishing one word", () => {
    const [first] = predictIntent(index, "resu");
    expect(first.kind).toBe("phrase");
    expect(first.completion.startsWith("resu")).toBe(true);
    expect(first.ghost).not.toMatch(/^\s/);
  });

  it("composes ghost text that appends exactly to the typed query", () => {
    for (const query of ["res", "resume ", "review pull"]) {
      for (const suggestion of predictIntent(index, query)) {
        expect(suggestion.completion).toBe(query + suggestion.ghost);
      }
    }
  });

  it("predicts the next word after a trailing space without doubling it", () => {
    const suggestions = predictIntent(index, "resume ");
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect(suggestion.ghost.startsWith(" ")).toBe(false);
      expect(suggestion.completion).not.toMatch(/ {2}/);
    }
  });

  it("ranks whole-phrase matches above single-word completions", () => {
    const suggestions = predictIntent(index, "review pu");
    expect(suggestions[0].kind).toBe("phrase");
  });

  it("preserves the operator's own casing", () => {
    const [first] = predictIntent(index, "Resu");
    expect(first.completion.startsWith("Resu")).toBe(true);
  });

  it("never echoes the query back unchanged", () => {
    for (const suggestion of predictIntent(index, "resume a previous session")) {
      // Prefix-style suggestions must always add visible text. Intent suggestions replace
      // the query instead of extending it, so they carry no ghost by design — but they
      // must still differ from what was typed.
      if (suggestion.kind === "intent") {
        expect(suggestion.ghost).toBe("");
        expect(suggestion.completion).not.toBe("resume a previous session");
        continue;
      }
      expect(suggestion.ghost.trim()).not.toBe("");
    }
  });

  it("honours the limit and is deterministic across runs", () => {
    const first = predictIntent(index, "re", 3);
    const second = predictIntent(index, "re", 3);
    expect(first.length).toBeLessThanOrEqual(3);
    expect(first).toEqual(second);
  });

  it("returns no duplicate completions", () => {
    const completions = predictIntent(index, "re", 10).map((item) => item.completion.toLowerCase());
    expect(new Set(completions).size).toBe(completions.length);
  });
});

describe("predictIntent against the real catalog", () => {
  it("suggests real catalog vocabulary for a partial word", () => {
    expect(realCatalog.ok).toBe(true);
    if (!realCatalog.ok) return;
    const index = createPredictionIndex(realCatalog.catalog.entries);
    const suggestions = predictIntent(index, "sess");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].completion.toLowerCase()).toContain("sess");
  });

  it("offers starter prompts drawn from real task groups", () => {
    if (!realCatalog.ok) return;
    const index = createPredictionIndex(realCatalog.catalog.entries);
    const starters = starterPrompts(index, 5);
    expect(starters.length).toBe(5);
    const taskGroups = new Set(realCatalog.catalog.entries.map((item) => item.task_group.replaceAll("-", " ")));
    for (const starter of starters) expect(taskGroups.has(starter)).toBe(true);
  });
});
