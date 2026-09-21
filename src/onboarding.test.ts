import { describe, expect, it } from "vitest";
import catalogJson from "../data/catalog.json";
import { PRODUCTS, parseCatalog, type CatalogEntry } from "./catalog";
import { createSearchIndex } from "./search";
import { buildOnboardingPath } from "./onboarding";

const parsed = parseCatalog(catalogJson);
if (!parsed.ok) throw new Error("catalog must parse");
const entries: readonly CatalogEntry[] = parsed.catalog.entries;
const index = createSearchIndex(entries);
const byId = new Map(entries.map((entry) => [entry.id, entry]));

describe("buildOnboardingPath", () => {
  it("builds a route for every product", () => {
    for (const product of PRODUCTS) {
      const path = buildOnboardingPath(index, product);
      expect(path.product).toBe(product);
      expect(path.steps.length).toBeGreaterThan(0);
      expect(path.title.length).toBeGreaterThan(0);
      expect(path.intro.length).toBeGreaterThan(0);
    }
  });

  it("gives every product a substantial route", () => {
    // Routes are product-shaped (a desktop has no session to start), so step counts differ.
    // What must hold is that no product gets a token route.
    for (const product of PRODUCTS) {
      expect(buildOnboardingPath(index, product).steps.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("never emits a step with no command for it", () => {
    // An empty step reads to a newcomer as something they failed to find. If a product has
    // no safe command for a step, that step must not be in its route at all.
    for (const product of PRODUCTS) {
      for (const step of buildOnboardingPath(index, product).steps) {
        expect(step.commands.length).toBeGreaterThan(0);
      }
    }
  });

  it("never shows the same command text twice within a step", () => {
    for (const product of PRODUCTS) {
      for (const step of buildOnboardingPath(index, product).steps) {
        const texts = step.commands.map((command) => command.command.trim().toLowerCase());
        expect(new Set(texts).size).toBe(texts.length);
      }
    }
  });

  // The hard safety contract for a teaching route.
  it("never proposes a destructive or red command to a newcomer", () => {
    for (const product of PRODUCTS) {
      for (const step of buildOnboardingPath(index, product).steps) {
        for (const command of step.commands) {
          expect(command.destructive).toBe(false);
          expect(command.safety_level).not.toBe("red");
        }
      }
    }
  });

  it("only proposes real, available entries from this product's catalog", () => {
    for (const product of PRODUCTS) {
      for (const step of buildOnboardingPath(index, product).steps) {
        for (const command of step.commands) {
          const real = byId.get(command.id);
          expect(real).toBeDefined();
          expect(real!.command).toBe(command.command);
          expect(command.available).toBe(true);
          expect(command.product).toBe(product);
        }
      }
    }
  });

  it("never repeats the same command across steps", () => {
    for (const product of PRODUCTS) {
      const seen = new Set<string>();
      for (const step of buildOnboardingPath(index, product).steps) {
        for (const command of step.commands) {
          expect(seen.has(command.id)).toBe(false);
          seen.add(command.id);
        }
      }
    }
  });

  it("gives every step a reason, an action and a takeaway", () => {
    for (const product of PRODUCTS) {
      for (const step of buildOnboardingPath(index, product).steps) {
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.why.length).toBeGreaterThan(20);
        expect(step.doThis.length).toBeGreaterThan(20);
        expect(step.youLearned.length).toBeGreaterThan(20);
      }
    }
  });

  it("teaches session work only for products that have sessions", () => {
    const desktop = buildOnboardingPath(index, "omarchy");
    expect(desktop.steps.some((step) => step.id === "start-work")).toBe(false);
    expect(desktop.steps.some((step) => step.id === "navigate")).toBe(true);

    const agent = buildOnboardingPath(index, "hermes");
    expect(agent.steps.some((step) => step.id === "start-work")).toBe(true);
    expect(agent.steps.some((step) => step.id === "navigate")).toBe(false);
  });

  it("keeps steps in canonical teaching order for every product", () => {
    // Routes are product-shaped and steps with no safe command are dropped, so not every
    // product has every step. What must never change is the ORDER: orientation before
    // action, action before verification, recovery last.
    const canonical = ["orient", "find-help", "start-work", "inspect-change", "verify", "navigate", "launch", "recover"];
    for (const product of PRODUCTS) {
      const ids = buildOnboardingPath(index, product).steps.map((step) => step.id);
      const ranks = ids.map((id) => canonical.indexOf(id));
      expect(ranks.every((rank) => rank >= 0)).toBe(true);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    }
  });

  it("teaches recovery last whenever the product has a recovery step", () => {
    for (const product of PRODUCTS) {
      const ids = buildOnboardingPath(index, product).steps.map((step) => step.id);
      if (!ids.includes("recover")) continue;
      expect(ids[ids.length - 1]).toBe("recover");
    }
  });

  it("begins every route with a read-only lesson", () => {
    // Whatever the product, the first thing a newcomer is shown must not change state.
    for (const product of PRODUCTS) {
      const first = buildOnboardingPath(index, product).steps[0];
      expect(["orient", "find-help", "navigate"]).toContain(first.id);
      expect(first.commands.every((command) => command.safety_level === "green")).toBe(true);
    }
  });

  it("is deterministic across runs", () => {
    const first = buildOnboardingPath(index, "hermes");
    const second = buildOnboardingPath(index, "hermes");
    expect(first.steps.map((step) => step.commands.map((command) => command.id)))
      .toEqual(second.steps.map((step) => step.commands.map((command) => command.id)));
  });

  it("caps commands per step so a newcomer is not flooded", () => {
    for (const product of PRODUCTS) {
      for (const step of buildOnboardingPath(index, product).steps) {
        expect(step.commands.length).toBeLessThanOrEqual(3);
      }
    }
  });

  // These lock in bugs found by reading real generated routes: search alone offered
  // "/quit" as a help lesson, a power-off hotkey as "open what you need", and an
  // editing hotkey ("move cursor to start of line") as "start a session".
  it("never teaches quitting or powering off as a lesson", () => {
    const forbidden = [/^\/quit/i, /^\/exit/i, /poweroff/i, /^XF86PowerOff$/i];
    for (const product of PRODUCTS) {
      for (const step of buildOnboardingPath(index, product).steps) {
        for (const command of step.commands) {
          expect(forbidden.some((pattern) => pattern.test(command.command))).toBe(false);
        }
      }
    }
  });

  it("does not offer a cursor-movement hotkey as the way to start a session", () => {
    for (const product of PRODUCTS) {
      const step = buildOnboardingPath(index, product).steps.find((item) => item.id === "start-work");
      if (!step) continue;
      for (const command of step.commands) {
        expect(/move cursor|start of (the )?(current )?line/i.test(command.description)).toBe(false);
      }
    }
  });

  it("leads each step with a named command rather than a single-letter accelerator", () => {
    for (const product of PRODUCTS) {
      for (const step of buildOnboardingPath(index, product).steps) {
        const lead = step.commands[0];
        // A one-character command is a power-user accelerator, not a teaching example.
        expect(lead.command.replace(/[^a-z0-9]/gi, "").length).toBeGreaterThan(1);
      }
    }
  });

  it("assigns a command to the step it fits best, not the first step that asks", () => {
    // Regression: a shared "used" set let the help step claim every menu hotkey, leaving
    // the launch step empty even though the catalog clearly contains a launcher.
    const desktop = buildOnboardingPath(index, "omarchy");
    const launch = desktop.steps.find((step) => step.id === "launch");
    expect(launch).toBeDefined();
    expect(launch!.commands.length).toBeGreaterThan(0);
  });

  it("does not teach a text-editing hotkey as the way to find help", () => {
    // Found in the live route: "Alt+Enter — Insert a newline in the prompt" was offered
    // as a help lesson because its description mentions the prompt.
    for (const product of PRODUCTS) {
      const step = buildOnboardingPath(index, product).steps.find((item) => item.id === "find-help");
      if (!step) continue;
      for (const command of step.commands) {
        expect(/newline|insert a|clipboard|paste/i.test(command.description)).toBe(false);
      }
    }
  });
});
