import { describe, expect, it, vi } from "vitest";
import type { CatalogEntry } from "./catalog";
import { createNativeActions, getActionAvailability } from "./actions";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "entry-1",
    product: "hermes",
    product_version: "0.21.3",
    interface: "shell-command",
    task_group: "help-and-reference",
    category: "help-and-reference",
    command: "hermes help",
    canonical_chord: "",
    aliases: [],
    description: "Show help",
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

describe("action availability", () => {
  it("allows copy for every selected catalog entry", () => {
    expect(getActionAvailability(entry({ available: false, safety_level: "red" })).copy).toBe(true);
  });

  it.each(["shell-command", "cli-flag"] as const)("allows guarded insertion for available non-red %s entries", (interfaceType) => {
    expect(getActionAvailability(entry({ interface: interfaceType, safety_level: "amber" })).insert).toBe(true);
  });

  it.each(["hotkey", "slash-command", "menu-action"] as const)("rejects insertion for the %s interface", (interfaceType) => {
    const availability = getActionAvailability(entry({ interface: interfaceType }));
    expect(availability.insert).toBe(false);
    expect(availability.insertReason).toMatch(/terminal-compatible/i);
  });

  it("rejects insertion for unavailable entries", () => {
    const availability = getActionAvailability(entry({ available: false }));
    expect(availability.insert).toBe(false);
    expect(availability.insertReason).toMatch(/unavailable/i);
  });

  it("makes red entries copy-only with an explicit warning", () => {
    const availability = getActionAvailability(entry({ safety_level: "red" }));
    expect(availability.insert).toBe(false);
    expect(availability.warning).toMatch(/danger|red/i);
  });
});

describe("native action bridge", () => {
  it("sends only the selected entry identity and command to the copy command", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const actions = createNativeActions(invoke);
    const selected = entry();

    await actions.copy(selected);

    expect(invoke).toHaveBeenCalledWith("copy_catalog_command", {
      entryId: selected.id,
      command: selected.command,
    });
  });

  it("requests guarded insertion without a target or safety claim", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const actions = createNativeActions(invoke);
    const selected = entry();

    await actions.insert(selected);

    expect(invoke).toHaveBeenCalledWith("insert_catalog_command", {
      entryId: selected.id,
      command: selected.command,
    });
  });
});
