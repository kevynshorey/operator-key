import { describe, expect, it } from "vitest";
import catalogJson from "../data/catalog.json";
import { parseCatalog, type CatalogEntry } from "./catalog";
import { createSearchIndex } from "./search";
import { explainCommand } from "./explain";

const parsed = parseCatalog(catalogJson);
if (!parsed.ok) throw new Error("catalog must parse");
const entries: readonly CatalogEntry[] = parsed.catalog.entries;
const index = createSearchIndex(entries);

describe("explainCommand", () => {
  it("returns null for empty input", () => {
    expect(explainCommand(index, "")).toBeNull();
    expect(explainCommand(index, "   ")).toBeNull();
  });

  it("recognises an exact catalog command and uses its own description", () => {
    const subject = entries.find((entry) => entry.interface === "slash-command" && entry.available);
    expect(subject).toBeDefined();
    const result = explainCommand(index, subject!.command);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("exact");
    expect(result!.entry?.id).toBe(subject!.id);
    expect(result!.summary).toBe(subject!.description);
  });

  it("strips a copied shell prompt before matching", () => {
    const subject = entries.find((entry) => entry.interface === "slash-command" && entry.available);
    const result = explainCommand(index, `$ ${subject!.command}`);
    expect(result!.input).toBe(subject!.command);
    expect(result!.confidence).toBe("exact");
  });

  it("explains an unknown command from its structure rather than refusing", () => {
    const result = explainCommand(index, "tar -xzvf archive.tar.gz");
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("unknown");
    expect(result!.anatomy.length).toBeGreaterThan(1);
    expect(result!.anatomy[0].role).toBe("program");
    expect(result!.anatomy[0].text).toBe("tar");
  });

  // The core safety contract: an unknown command must never be implied to be harmless.
  it("flags rm -rf as dangerous even though it is not in the catalog", () => {
    const result = explainCommand(index, "rm -rf ./build");
    expect(result!.confidence).toBe("unknown");
    expect(result!.impliedSafety).toBe("red");
    expect(result!.risks.some((risk) => risk.severity === "danger")).toBe(true);
    expect(result!.risks.some((risk) => /delete/i.test(risk.title))).toBe(true);
  });

  it("flags curl piped into a shell", () => {
    const result = explainCommand(index, "curl -sSL https://example.com/install.sh | sh");
    expect(result!.impliedSafety).toBe("red");
    expect(result!.risks.some((risk) => /downloads and runs/i.test(risk.title))).toBe(true);
  });

  it("flags force push and hard reset", () => {
    expect(explainCommand(index, "git push --force origin main")!.impliedSafety).toBe("red");
    expect(explainCommand(index, "git reset --hard HEAD~1")!.impliedSafety).toBe("red");
  });

  it("flags sudo as a warning without calling it catastrophic", () => {
    const result = explainCommand(index, "sudo systemctl restart nginx");
    expect(result!.risks.some((risk) => /administrator/i.test(risk.title))).toBe(true);
    expect(result!.impliedSafety).toBe("amber");
  });

  it("distinguishes overwrite from append redirects", () => {
    const overwrite = explainCommand(index, "echo hi > notes.txt");
    expect(overwrite!.risks.some((risk) => /overwrites a file/i.test(risk.title))).toBe(true);

    // ">>" is an append and must never be reported as an overwrite. Nor should the
    // stderr forms, which do not truncate a target file the operator cares about.
    for (const safe of ["echo hi >> notes.txt", "make 2>&1 | tee log", "ls a >> b"]) {
      const result = explainCommand(index, safe);
      expect(result!.risks.some((risk) => /overwrites a file/i.test(risk.title))).toBe(false);
    }
  });

  it("explains shell operators as their own tokens", () => {
    const result = explainCommand(index, "cat log.txt | grep error");
    const pipe = result!.anatomy.find((token) => token.text === "|");
    expect(pipe).toBeDefined();
    expect(pipe!.role).toBe("operator");
    expect(pipe!.explanation).toMatch(/pipe/i);
  });

  it("treats the word after a connector as a new program", () => {
    const result = explainCommand(index, "cat log.txt | grep error");
    const grep = result!.anatomy.find((token) => token.text === "grep");
    expect(grep!.role).toBe("program");
  });

  it("never reports a safety level below what the catalog asserts", () => {
    const reds = entries.filter((entry) => entry.safety_level === "red" && entry.available).slice(0, 40);
    for (const entry of reds) {
      const result = explainCommand(index, entry.command);
      if (result?.entry?.id !== entry.id) continue;
      expect(result.impliedSafety).toBe("red");
    }
  });

  it("only claims an exact match when the text really is the command", () => {
    const result = explainCommand(index, "some text that is definitely not a command here");
    expect(result!.confidence).not.toBe("exact");
  });

  it("never returns a related entry that duplicates the matched entry", () => {
    const subject = entries.find((entry) => entry.interface === "slash-command" && entry.available);
    const result = explainCommand(index, subject!.command);
    expect(result!.related.every((item) => item.id !== result!.entry?.id)).toBe(true);
  });

  it("produces an explanation for every token it emits", () => {
    const samples = [
      "rm -rf /tmp/x",
      "hermes chat",
      "git commit -m 'message'",
      "ls -la ~/Work && echo done",
    ];
    for (const sample of samples) {
      for (const token of explainCommand(index, sample)!.anatomy) {
        expect(token.text.length).toBeGreaterThan(0);
        expect(token.explanation.length).toBeGreaterThan(10);
      }
    }
  });

  // Found by reading the live panel: two rm rules both fired, producing near-identical
  // warnings. Duplicated alarms dilute the one that matters.
  it("does not repeat the same hazard twice", () => {
    const result = explainCommand(index, "rm -rf ./build");
    const titles = result!.risks.map((risk) => risk.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles.filter((title) => /delete/i.test(title)).length).toBe(1);
  });

  it("still catches rm with separated flags", () => {
    expect(explainCommand(index, "rm -r -f ./build")!.impliedSafety).toBe("red");
  });

  // Found by reading the live panel: "rm -rf ./build" offered "--skip-build" as a
  // related command purely because both contain "build".
  it("does not offer unrelated commands for an unknown program", () => {
    const result = explainCommand(index, "rm -rf ./build");
    for (const candidate of result!.related) {
      expect(candidate.command.toLowerCase()).toContain("rm");
    }
  });
});
