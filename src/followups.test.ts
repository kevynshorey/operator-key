import { describe, expect, it } from "vitest";
import catalogJson from "../data/catalog.json";
import { parseCatalog, type CatalogEntry } from "./catalog";
import { createSearchIndex } from "./search";
import { buildFollowUps, type FollowUpClass } from "./followups";

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
const realIndex = realCatalog.ok ? createSearchIndex(realCatalog.catalog.entries) : undefined;

function kinds(followUps: readonly { kind: FollowUpClass }[]): FollowUpClass[] {
  return followUps.map((item) => item.kind);
}

describe("buildFollowUps signal detection", () => {
  const index = createSearchIndex([entry()]);

  it("always asks the operator to confirm the result", () => {
    expect(kinds(buildFollowUps(index, entry()))).toContain("verify");
  });

  it("requires a recovery path for destructive entries", () => {
    const [first] = buildFollowUps(index, entry({ destructive: true, safety_level: "red" }));
    expect(first.kind).toBe("recover");
    expect(first.priority).toBe("required");
    expect(first.rationale).toContain("red");
  });

  it("recommends recovery for amber entries without requiring it", () => {
    const recover = buildFollowUps(index, entry({ safety_level: "amber" }))
      .find((item) => item.kind === "recover");
    expect(recover?.priority).toBe("recommended");
  });

  it("raises no recovery class for a safe read-only entry", () => {
    expect(kinds(buildFollowUps(index, entry()))).not.toContain("recover");
  });

  it("requires security review when a credential token appears", () => {
    const security = buildFollowUps(index, entry({
      command: "hermes auth add", description: "store an api key", safety_level: "amber",
    })).find((item) => item.kind === "security");
    expect(security?.priority).toBe("required");
    expect(security?.rationale).toMatch(/auth|key/);
  });

  it("requires code checks when the command publishes work", () => {
    const quality = buildFollowUps(index, entry({
      command: "git push origin main", description: "push commits to the remote",
      task_group: "development", safety_level: "amber",
    })).find((item) => item.kind === "quality");
    expect(quality?.priority).toBe("required");
    expect(quality?.rationale).toContain("publishes work");
  });

  it("recommends code checks for local edits without requiring them", () => {
    const quality = buildFollowUps(index, entry({
      command: "hermes config edit", description: "edit the configuration file",
      task_group: "configuration",
    })).find((item) => item.kind === "quality");
    expect(quality?.priority).toBe("recommended");
  });

  it("raises iteration guidance for agent and session work", () => {
    expect(kinds(buildFollowUps(index, entry({
      command: "hermes chat", description: "start an agent session",
    })))).toContain("iterate");
  });

  it("orders required guidance before recommended and optional", () => {
    const followUps = buildFollowUps(index, entry({
      command: "git push --force", description: "force push and overwrite remote auth tokens",
      destructive: true, safety_level: "red", task_group: "development",
    }));
    const order = followUps.map((item) => item.priority);
    const rank = { required: 0, recommended: 1, optional: 2 } as const;
    for (let i = 1; i < order.length; i += 1) {
      expect(rank[order[i]]).toBeGreaterThanOrEqual(rank[order[i - 1]]);
    }
  });

  it("honours the limit and never repeats a class", () => {
    const followUps = buildFollowUps(index, entry({
      command: "git push --force", description: "force push over auth tokens",
      destructive: true, safety_level: "red", task_group: "development",
    }), 3);
    expect(followUps.length).toBeLessThanOrEqual(3);
    expect(new Set(kinds(followUps)).size).toBe(followUps.length);
  });

  it("gives every follow-up an operator-facing question and a rationale", () => {
    for (const followUp of buildFollowUps(index, entry({ destructive: true, safety_level: "red" }))) {
      expect(followUp.question.length).toBeGreaterThan(0);
      expect(followUp.rationale.length).toBeGreaterThan(0);
      expect(followUp.title.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic across repeated calls", () => {
    const subject = entry({ destructive: true, safety_level: "red", task_group: "development" });
    expect(buildFollowUps(index, subject)).toEqual(buildFollowUps(index, subject));
  });
});

describe("buildFollowUps catalog trust boundary", () => {
  it("only ever proposes real, available catalog entries", () => {
    expect(realCatalog.ok).toBe(true);
    if (!realCatalog.ok || !realIndex) return;
    const byId = new Map(realCatalog.catalog.entries.map((item) => [item.id, item]));
    const subjects = realCatalog.catalog.entries.filter((_, position) => position % 97 === 0);

    for (const subject of subjects) {
      for (const followUp of buildFollowUps(realIndex, subject)) {
        for (const action of followUp.actions) {
          const known = byId.get(action.entry.id);
          expect(known).toBeDefined();
          // Identity must come from the catalog, never from the engine.
          expect(action.entry.command).toBe(known!.command);
          expect(action.entry.safety_level).toBe(known!.safety_level);
          expect(action.entry.provenance).toEqual(known!.provenance);
          expect(action.entry.available).toBe(true);
        }
      }
    }
  });

  it("never proposes the selected entry as its own follow-up", () => {
    if (!realCatalog.ok || !realIndex) return;
    for (const subject of realCatalog.catalog.entries.filter((_, position) => position % 89 === 0)) {
      for (const followUp of buildFollowUps(realIndex, subject)) {
        for (const action of followUp.actions) {
          expect(action.entry.id).not.toBe(subject.id);
        }
      }
    }
  });

  it("never repeats an action within one follow-up", () => {
    if (!realCatalog.ok || !realIndex) return;
    for (const subject of realCatalog.catalog.entries.filter((_, position) => position % 101 === 0)) {
      for (const followUp of buildFollowUps(realIndex, subject)) {
        const ids = followUp.actions.map((action) => action.entry.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it("resolves guidance for a real destructive catalog entry", () => {
    if (!realCatalog.ok || !realIndex) return;
    const destructive = realCatalog.catalog.entries.find((item) => item.destructive && item.available);
    if (!destructive) return;
    const followUps = buildFollowUps(realIndex, destructive);
    expect(followUps[0].priority).toBe("required");
    expect(followUps.some((item) => item.actions.length > 0)).toBe(true);
  });

  it("does not claim a green read-only command publishes work", () => {
    // Regression: /code-review only DESCRIBES posting to a PR. Keyword-matching its prose
    // wrongly escalated it to a required pre-publish check.
    if (!realCatalog.ok || !realIndex) throw new Error("catalog must parse");
    const reviewEntry = realCatalog.catalog.entries.find((item) => item.command === "/code-review");
    expect(reviewEntry).toBeDefined();
    expect(reviewEntry!.safety_level).toBe("green");

    const followUps = buildFollowUps(realIndex, reviewEntry!);
    const quality = followUps.find((item) => item.kind === "quality");
    if (quality) {
      expect(quality.rationale).not.toMatch(/publishes work/i);
      expect(quality.priority).not.toBe("required");
    }
  });

  it("never marks a green non-destructive command as requiring anything", () => {
    if (!realCatalog.ok || !realIndex) throw new Error("catalog must parse");
    const greens = realCatalog.catalog.entries
      .filter((item) => item.safety_level === "green" && !item.destructive)
      .slice(0, 250);
    for (const subject of greens) {
      for (const followUp of buildFollowUps(realIndex, subject)) {
        expect(followUp.priority).not.toBe("required");
      }
    }
  });
});
