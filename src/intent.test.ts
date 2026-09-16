import { describe, expect, it, vi } from "vitest";
import type { CatalogEntry } from "./catalog";
import type { SearchResult } from "./search";
import {
  buildIntentCandidateIds,
  createBrowserIntentReasoner,
  createNativeIntentReasoner,
  mapIntentPlanEntries,
  type SparkIntentPlan,
} from "./intent";

function entry(id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id,
    product: "hermes",
    product_version: "1",
    interface: "shell-command",
    task_group: "development",
    category: "development",
    command: id,
    canonical_chord: "",
    aliases: [],
    description: "",
    context: "terminal",
    safety_level: "green",
    destructive: false,
    available: true,
    conflict_ids: [],
    source: "test",
    provenance: { kind: "official", status: "active", source: "test", version: "1" },
    ...overrides,
  };
}

function result(item: CatalogEntry, score = 1): SearchResult {
  return { entry: item, score, matchedTerms: [], unavailable: !item.available };
}

function plan(recommendations: SparkIntentPlan["recommendations"]): SparkIntentPlan {
  return {
    summary: "Do the work",
    assumptions: [],
    recommendations,
    gaps: [],
    model: "gpt-5.6-luna",
  };
}

describe("intent candidate pool", () => {
  it("places exact local results before broad any-term matches without mutating inputs", () => {
    const exact = entry("exact", { command: "review code", description: "Review code" });
    const command = entry("command", { command: "review changes" });
    const alias = entry("alias", { command: "other", aliases: ["review"] });
    const description = entry("description", { command: "other", description: "Review a patch" });
    const unrelated = entry("fallback", { command: "launch session" });
    const entries = [unrelated, description, alias, command, exact];
    const exactResults = [result(exact, 50)];
    const entriesSnapshot = [...entries];
    const resultsSnapshot = [...exactResults];

    expect(buildIntentCandidateIds(entries, "please review code carefully", {}, exactResults).slice(0, 5)).toEqual([
      "exact", "command", "alias", "description", "fallback",
    ]);
    expect(entries).toEqual(entriesSnapshot);
    expect(exactResults).toEqual(resultsSnapshot);
  });

  it("rescues useful any-term candidates when AND search returns zero because of natural-language words", () => {
    const entries = [
      entry("resume", { command: "hermes resume", aliases: ["resume session"], description: "Resume a prior session" }),
      entry("unrelated", { command: "hermes doctor", description: "Diagnose installation" }),
    ];

    const ids = buildIntentCandidateIds(entries, "Could you please resume my session from yesterday?", {}, []);

    expect(ids[0]).toBe("resume");
    expect(ids).toContain("unrelated");
  });

  it("expands plain outcome language so health checks and interactive sessions survive a crowded pool", () => {
    const distractors = Array.from({ length: 240 }, (_, index) => entry(`distractor-${String(index).padStart(3, "0")}`, {
      command: `open hermes tool ${index}`,
      description: "Open a Hermes utility.",
    }));
    const status = entry("status", { command: "hermes status", description: "Show the current agent status." });
    const chat = entry("chat", { command: "hermes chat", description: "Start a chat session." });

    const ids = buildIntentCandidateIds(
      [...distractors, status, chat],
      "Check whether Hermes is healthy, then open an interactive session.",
      {},
      [],
    );

    expect(ids).toContain("status");
    expect(ids).toContain("chat");
    expect(ids.length).toBeLessThanOrEqual(220);
  });

  it("scores exact, command, alias, task, description, then product evidence", () => {
    const entries = [
      entry("product", { product: "codex", command: "other" }),
      entry("description", { command: "other", description: "codex" }),
      entry("task", { command: "other", task_group: "review-and-verify", description: "" }),
      entry("alias", { command: "other", aliases: ["codex"] }),
      entry("command", { command: "run codex" }),
      entry("exact", { command: "codex" }),
    ];

    expect(buildIntentCandidateIds(entries, "codex", {}, []).slice(0, 6)).toEqual([
      "exact", "command", "alias", "description", "product", "task",
    ]);
  });

  it("adds deterministic product-by-task fallback diversity", () => {
    const entries = [
      entry("h-dev-2"),
      entry("o-help-1", { product: "omarchy", task_group: "help-and-reference" }),
      entry("h-dev-1"),
      entry("c-review-1", { product: "codex", task_group: "review-and-verify" }),
      entry("o-help-2", { product: "omarchy", task_group: "help-and-reference" }),
    ];

    const first = buildIntentCandidateIds(entries, "no lexical evidence", {}, []);
    const reversed = buildIntentCandidateIds([...entries].reverse(), "no lexical evidence", {}, []);

    expect(first).toEqual(["c-review-1", "h-dev-1", "o-help-1", "h-dev-2", "o-help-2"]);
    expect(reversed).toEqual(first);
  });

  it("applies every active filter to exact, broad, and fallback candidates", () => {
    const included = entry("included", {
      product: "codex",
      interface: "cli-flag",
      task_group: "review-and-verify",
      safety_level: "amber",
      command: "review",
    });
    const wrongProduct = entry("wrong-product", { command: "review" });
    const wrongInterface = entry("wrong-interface", { product: "codex", command: "review" });
    const wrongTask = entry("wrong-task", { product: "codex", interface: "cli-flag", command: "review" });
    const wrongSafety = entry("wrong-safety", {
      product: "codex", interface: "cli-flag", task_group: "review-and-verify", command: "review",
    });
    const entries = [wrongProduct, wrongInterface, wrongTask, wrongSafety, included];

    expect(buildIntentCandidateIds(entries, "review", {
      product: "codex", interface: "cli-flag", task: "review-and-verify", safety: "amber",
    }, entries.map((item) => result(item)))).toEqual(["included"]);
  });

  it("deduplicates IDs, prefers available entries, uses stable ID ties, and caps at 220", () => {
    const generated = Array.from({ length: 225 }, (_, index) => entry(`id-${String(index).padStart(3, "0")}`, {
      command: "match",
      available: index !== 0,
    }));
    const duplicate = { ...generated[5] };
    const ids = buildIntentCandidateIds([duplicate, ...generated].reverse(), "match", {}, [
      result(generated[0], 100), result(generated[2], 100), result(generated[1], 100), result(generated[2], 100),
    ]);

    expect(ids).toHaveLength(220);
    expect(new Set(ids).size).toBe(220);
    expect(ids.slice(0, 3)).toEqual(["id-001", "id-002", "id-000"]);
    expect(ids[3]).toBe("id-003");
  });
});

describe("intent reasoner adapters", () => {
  it("invokes only the closed native status and reason commands with exact payload keys", async () => {
    const status = {
      available: true,
      loggedIn: true,
      model: "gpt-5.6-luna",
      message: "Codex CLI is ready.",
    };
    const response = plan([]);
    const invoke = vi.fn(async (command: string) => command === "spark_intent_status" ? status : response);
    const reasoner = createNativeIntentReasoner(invoke);

    await expect(reasoner.status()).resolves.toEqual(status);
    await expect(reasoner.reason("review this", ["a", "b"])).resolves.toEqual(response);
    expect(invoke.mock.calls).toEqual([
      ["spark_intent_status"],
      ["reason_about_intent", { intent: "review this", candidateIds: ["a", "b"] }],
    ]);
  });

  it("reports actionable browser unavailability and never invokes a provider", async () => {
    const reasoner = createBrowserIntentReasoner();

    await expect(reasoner.status()).resolves.toEqual({
      available: false,
      loggedIn: false,
      model: "gpt-5.6-luna",
      message: "Luna reasoning requires the native Operator Key companion with an authenticated Codex CLI.",
    });
    await expect(reasoner.reason("review this", ["a"])).rejects.toThrow(/native Operator Key companion.*Codex CLI/i);
  });
});

describe("validated plan catalog mapping", () => {
  const first = entry("first");
  const second = entry("second");

  it("maps exact entries without changing recommendation order or sequence", () => {
    const mapped = mapIntentPlanEntries(plan([
      { entryId: "second", sequence: 2, purpose: "Then", inputHint: "none", confidence: "medium" },
      { entryId: "first", sequence: 1, purpose: "First", inputHint: "path", confidence: "high" },
    ]), [first, second]);

    expect(mapped).toEqual({ ok: true, recommendations: [
      expect.objectContaining({ entryId: "second", sequence: 2, entry: second }),
      expect.objectContaining({ entryId: "first", sequence: 1, entry: first }),
    ] });
  });

  it("returns a structured error for an unknown ID instead of silently dropping it", () => {
    expect(mapIntentPlanEntries(plan([
      { entryId: "missing", sequence: 1, purpose: "Missing", inputHint: "none", confidence: "low" },
    ]), [first])).toEqual({ ok: false, error: { code: "unknown-entry-id", entryId: "missing" } });
  });

  it("returns a structured error for duplicate recommendation IDs", () => {
    expect(mapIntentPlanEntries(plan([
      { entryId: "first", sequence: 1, purpose: "One", inputHint: "none", confidence: "high" },
      { entryId: "first", sequence: 2, purpose: "Again", inputHint: "none", confidence: "low" },
    ]), [first])).toEqual({ ok: false, error: { code: "duplicate-entry-id", entryId: "first" } });
  });
});
