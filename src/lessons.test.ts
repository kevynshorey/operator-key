import { describe, expect, it } from "vitest";
import catalogJson from "../data/catalog.json";
import { parseCatalog, type CatalogEntry } from "./catalog";
import { buildLessons, lessonIds, lessonReferences } from "./lessons";

const parsed = parseCatalog(catalogJson);
if (!parsed.ok) throw new Error(`catalog fixture is unusable: ${parsed.error}`);
const entries: CatalogEntry[] = parsed.catalog.entries;
const lessons = buildLessons(entries);

/** Products this machine's catalog actually contains, so absence is not read as failure. */
const cataloguedProducts = new Set(entries.map((entry) => entry.product));

describe("lesson library", () => {
  it("resolves every referenced command against the real catalog", () => {
    // THE guarantee that makes lessons trustworthy: a lesson may only teach commands the
    // catalog can prove exist. If an upstream tool renames or removes a command, this
    // test fails on the next rebuild instead of the app silently teaching fiction.
    const unresolved = lessonReferences().filter((ref) => {
      if (!cataloguedProducts.has(ref.product)) return false; // tool absent here, not a lie
      return !entries.some(
        (entry) => entry.product === ref.product
          && entry.command.trim().toLowerCase() === ref.command.trim().toLowerCase(),
      );
    });
    expect(unresolved).toEqual([]);
  });

  it("reports every lesson as complete on a machine with the tools installed", () => {
    for (const lesson of lessons) {
      const missingProduct = lesson.requires.some((product) => !cataloguedProducts.has(product));
      if (missingProduct) continue;
      expect(lesson.complete, `${lesson.id}: ${lesson.caveat}`).toBe(true);
    }
  });

  it("never silently drops a command it could not resolve", () => {
    // A lesson that hides a gap reads as complete while teaching one. Incomplete lessons
    // must carry a caveat naming what is missing.
    for (const lesson of lessons) {
      const missing = lesson.steps.reduce((total, step) => total + step.missing.length, 0);
      if (missing > 0) {
        expect(lesson.complete).toBe(false);
        expect(lesson.caveat.length).toBeGreaterThan(0);
      } else {
        expect(lesson.caveat).toBe("");
      }
    }
  });

  it("gives every step a resolved command when its product is installed", () => {
    for (const lesson of lessons) {
      if (lesson.requires.some((product) => !cataloguedProducts.has(product))) continue;
      for (const step of lesson.steps) {
        expect(step.commands.length, `${lesson.id}/${step.id} has no command`).toBeGreaterThan(0);
      }
    }
  });

  it("never teaches a destructive command as the thing to do", () => {
    // A lesson is read by someone who does not yet know what is safe. Hazards belong in
    // `watchOut` prose, never as a command the step tells them to run.
    for (const lesson of lessons) {
      for (const step of lesson.steps) {
        for (const command of step.commands) {
          expect(
            command.destructive,
            `${lesson.id}/${step.id} teaches destructive ${command.command}`,
          ).toBe(false);
          expect(
            command.safety_level,
            `${lesson.id}/${step.id} teaches red ${command.command}`,
          ).not.toBe("red");
        }
      }
    }
  });

  it("teaches the canonical command rather than a machine-local alias", () => {
    // `git st` is real on the machine that configured it and nonexistent everywhere else.
    for (const lesson of lessons) {
      for (const step of lesson.steps) {
        for (const command of step.commands) {
          expect(
            command.provenance.kind,
            `${lesson.id}/${step.id} teaches local alias ${command.command}`,
          ).not.toBe("override");
        }
      }
    }
  });

  it("prefers a real command over a flag that shares its text", () => {
    for (const lesson of lessons) {
      for (const step of lesson.steps) {
        for (const command of step.commands) {
          expect(command.interface).not.toBe("cli-flag");
        }
      }
    }
  });

  it("covers git, GitHub and agent-skill workflows the user asked for", () => {
    const ids = lessonIds();
    expect(ids).toContain("git-first-save");
    expect(ids).toContain("github-first-pr");
    expect(ids).toContain("extend-with-skills");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("writes lessons in prose a newcomer can act on", () => {
    for (const lesson of lessons) {
      expect(lesson.title.length).toBeGreaterThan(0);
      expect(lesson.audience.length).toBeGreaterThan(20);
      expect(lesson.summary.length).toBeGreaterThan(40);
      expect(lesson.steps.length).toBeGreaterThanOrEqual(4);
      for (const step of lesson.steps) {
        expect(step.title.length).toBeGreaterThan(0);
        // Explanations must teach, not label. A one-line restatement of the command name
        // is what the catalog already gives; a lesson has to add the reason.
        expect(step.explain.length, `${lesson.id}/${step.id}`).toBeGreaterThan(80);
      }
    }
  });

  it("warns about force-pushing where it would actually happen", () => {
    // Regression guard for the specific hazard most likely to hurt a newcomer following
    // the first-PR lesson.
    const pr = lessons.find((lesson) => lesson.id === "github-first-pr");
    expect(pr).toBeDefined();
    const pushStep = pr!.steps.find((step) => step.id === "push");
    expect(pushStep?.watchOut ?? "").toMatch(/force-with-lease/i);
  });

  it("tells the learner to inspect a skill before installing it", () => {
    const skills = lessons.find((lesson) => lesson.id === "extend-with-skills");
    const inspect = skills?.steps.findIndex((step) => step.id === "inspect") ?? -1;
    const install = skills?.steps.findIndex((step) => step.id === "install") ?? -1;
    expect(inspect).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(inspect);
  });

  it("stays honest when a tool is missing from the catalog", () => {
    // Simulate a machine without gh: the GitHub lesson must degrade to an explicit
    // caveat rather than pretending the commands exist.
    const withoutGh = entries.filter((entry) => entry.product !== "gh");
    const degraded = buildLessons(withoutGh).find((lesson) => lesson.id === "github-first-pr");
    expect(degraded).toBeDefined();
    expect(degraded!.complete).toBe(false);
    expect(degraded!.caveat).toMatch(/gh/);
    expect(degraded!.caveat).toMatch(/not in this machine's catalog/i);
    // The git steps still resolve, so the lesson stays partially useful.
    expect(degraded!.steps.some((step) => step.commands.length > 0)).toBe(true);
  });
});
