import { describe, expect, it } from "vitest";
import catalogJson from "../data/catalog.json";
import { parseCatalog, type CatalogEntry } from "./catalog";
import { buildCommandLesson, createTeachingIndex } from "./teach";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "subject",
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

describe("buildCommandLesson anatomy", () => {
  const teaching = createTeachingIndex([entry()]);

  it("names the program and its subcommands", () => {
    const { anatomy } = buildCommandLesson(teaching, entry());
    expect(anatomy.map((token) => token.text)).toEqual(["hermes", "sessions", "list"]);
    expect(anatomy[0].role).toBe("program");
    expect(anatomy[1].role).toBe("subcommand");
  });

  it("classifies long and short flags", () => {
    const { anatomy } = buildCommandLesson(teaching, entry({ command: "hermes chat --verbose -q" }));
    expect(anatomy.find((token) => token.text === "--verbose")?.role).toBe("flag");
    expect(anatomy.find((token) => token.text === "-q")?.role).toBe("flag");
  });

  it("classifies placeholders and paths", () => {
    const { anatomy } = buildCommandLesson(teaching, entry({ command: "hermes export <SESSION> ~/out" }));
    expect(anatomy.find((token) => token.text === "<SESSION>")?.role).toBe("placeholder");
    expect(anatomy.find((token) => token.text === "~/out")?.role).toBe("path");
  });

  it("explains a flag from the catalog when one documents it", () => {
    const flagEntry = entry({
      id: "flag-entry", interface: "cli-flag", command: "--verbose",
      description: "print every tool call as it happens",
    });
    const index = createTeachingIndex([flagEntry, entry()]);
    const token = buildCommandLesson(index, entry({ command: "hermes chat --verbose" }))
      .anatomy.find((item) => item.text === "--verbose");
    expect(token?.sourcedFrom).toBe("flag-entry");
    expect(token?.explanation).toBe("print every tool call as it happens");
  });

  it("falls back to a generic explanation when the catalog documents no flag", () => {
    const token = buildCommandLesson(teaching, entry({ command: "hermes chat --unknown-flag" }))
      .anatomy.find((item) => item.text === "--unknown-flag");
    expect(token?.sourcedFrom).toBeUndefined();
    expect(token?.explanation).toContain("Long-form flag");
  });

  it("breaks a hotkey into modifiers and the final key", () => {
    const { anatomy } = buildCommandLesson(teaching, entry({
      interface: "hotkey", command: "SUPER + K", canonical_chord: "super+k",
      description: "show keybindings", product: "omarchy",
    }));
    expect(anatomy.map((token) => token.role)).toEqual(["modifier", "key"]);
    expect(anatomy[0].explanation).toContain("Super key");
  });

  it("marks a slash command as belonging to a session, not the shell", () => {
    const { anatomy } = buildCommandLesson(teaching, entry({
      interface: "slash-command", command: "/compress", description: "compress context",
    }));
    expect(anatomy[0].role).toBe("slash-command");
    expect(anatomy[0].explanation).toContain("running hermes session");
  });

  it("explains every token it emits", () => {
    for (const token of buildCommandLesson(teaching, entry({ command: "git push --force origin main" })).anatomy) {
      expect(token.explanation.length).toBeGreaterThan(0);
    }
  });
});

describe("buildCommandLesson glossary and briefing", () => {
  const teaching = createTeachingIndex([entry()]);

  it("defines the concepts a command depends on", () => {
    const terms = buildCommandLesson(teaching, entry({
      command: "hermes --continue", description: "resume the most recent session",
    })).glossary.map((item) => item.term);
    expect(terms).toContain("session");
    expect(terms).toContain("flag");
  });

  it("warns about elevated privilege when sudo appears", () => {
    const terms = buildCommandLesson(teaching, entry({
      command: "sudo systemctl restart hermes", description: "restart the service as root",
      safety_level: "amber",
    })).glossary.map((item) => item.term);
    expect(terms).toContain("elevated privilege");
  });

  it("gives a distinct safety briefing per level", () => {
    const green = buildCommandLesson(teaching, entry({ safety_level: "green" })).safetyBriefing;
    const amber = buildCommandLesson(teaching, entry({ safety_level: "amber" })).safetyBriefing;
    const red = buildCommandLesson(teaching, entry({ safety_level: "red" })).safetyBriefing;
    expect(new Set([green, amber, red]).size).toBe(3);
    expect(red).toContain("recovery path");
  });

  it("refuses to invite practice on a destructive command", () => {
    const hint = buildCommandLesson(teaching, entry({ destructive: true, safety_level: "red" })).practiceHint;
    expect(hint).toContain("Do not practise this on real work");
  });

  it("invites practice on a safe command", () => {
    expect(buildCommandLesson(teaching, entry()).practiceHint).toContain("Safe to run");
  });

  it("states which surface the command belongs to", () => {
    expect(buildCommandLesson(teaching, entry()).headline).toContain("terminal prompt");
    expect(buildCommandLesson(teaching, entry({ interface: "hotkey", canonical_chord: "super+k" })).headline)
      .toContain("desktop key combination");
  });
});

describe("buildCommandLesson against the real catalog", () => {
  it("produces a complete lesson for every sampled real entry", () => {
    expect(realCatalog.ok).toBe(true);
    if (!realCatalog.ok) return;
    const teaching = createTeachingIndex(realCatalog.catalog.entries);

    for (const subject of realCatalog.catalog.entries.filter((_, position) => position % 53 === 0)) {
      const lesson = buildCommandLesson(teaching, subject);
      expect(lesson.anatomy.length).toBeGreaterThan(0);
      expect(lesson.headline.length).toBeGreaterThan(0);
      expect(lesson.safetyBriefing.length).toBeGreaterThan(0);
      expect(lesson.practiceHint.length).toBeGreaterThan(0);
      for (const token of lesson.anatomy) {
        expect(token.text.length).toBeGreaterThan(0);
        expect(token.explanation.length).toBeGreaterThan(0);
      }
    }
  });

  it("sources flag explanations from real catalog entries only", () => {
    if (!realCatalog.ok) return;
    const byId = new Map(realCatalog.catalog.entries.map((item) => [item.id, item]));
    const teaching = createTeachingIndex(realCatalog.catalog.entries);

    for (const subject of realCatalog.catalog.entries.filter((_, position) => position % 37 === 0)) {
      for (const token of buildCommandLesson(teaching, subject).anatomy) {
        if (!token.sourcedFrom) continue;
        const source = byId.get(token.sourcedFrom);
        expect(source).toBeDefined();
        expect(token.explanation).toBe(source!.description);
        expect(source!.product).toBe(subject.product);
      }
    }
  });
});
