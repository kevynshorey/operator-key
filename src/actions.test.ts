import { describe, expect, it, vi } from "vitest";
import type { CatalogEntry } from "./catalog";
import {
  createBrowserActions,
  createNativeActions,
  getActionAvailability,
  readCatalogSnapshot,
  readDesktopCapabilities,
  readDesktopCompatibility,
  UNKNOWN_DESKTOP_CAPABILITIES,
  UNKNOWN_DESKTOP_COMPATIBILITY,
  UNSUPPORTED_INSERT_REASON,
  WEB_DESKTOP_CAPABILITIES,
} from "./actions";

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
  it("disables every insertion in web mode with the native companion reason", () => {
    const availability = getActionAvailability(entry(), "web");
    expect(availability.insert).toBe(false);
    expect(availability.insertReason).toBe("Install/open the native Operator Key companion to insert into a confirmed terminal.");
  });

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

  it("disables insertion with an explanation when the desktop cannot insert", () => {
    // On X11, GNOME or macOS the wl-copy/hyprctl/wtype helpers do not exist. The operator
    // previously saw a raw "could not start hyprctl" process error from the native side.
    const availability = getActionAvailability(entry({ interface: "shell-command", safety_level: "green" }), "native", {
      canCopy: true,
      canInsert: false,
    });

    expect(availability.copy).toBe(true);
    expect(availability.insert).toBe(false);
    expect(availability.insertReason).toBe(UNSUPPORTED_INSERT_REASON);
    expect(availability.insertReason).toMatch(/wayland/i);
    // Search and copy remain available, so the app is still useful on that desktop.
    expect(availability.insertReason).toMatch(/copy still work/i);
  });

  it("allows insertion when the desktop reports it is supported", () => {
    const availability = getActionAvailability(entry({ interface: "shell-command", safety_level: "green" }), "native", {
      canCopy: true,
      canInsert: true,
    });

    expect(availability.insert).toBe(true);
    expect(availability.insertReason).toBeUndefined();
  });

  it("treats an unknown desktop as unable to act rather than assuming success", () => {
    expect(UNKNOWN_DESKTOP_CAPABILITIES).toEqual({ canCopy: false, canInsert: false });
    expect(WEB_DESKTOP_CAPABILITIES).toEqual({ canCopy: true, canInsert: false });
  });
});

describe("desktop capability probe", () => {
  it.each([null, undefined, {}, { canCopy: "yes", canInsert: true }])("fails closed for malformed native capabilities %j", async (value) => {
    await expect(readDesktopCapabilities(vi.fn().mockResolvedValue(value))).resolves.toEqual(UNKNOWN_DESKTOP_CAPABILITIES);
  });

  it("does not promise native copy on an unsupported desktop", () => {
    const availability = getActionAvailability(entry(), "native", { canCopy: false, canInsert: false });
    expect(availability.copy).toBe(false);
    expect(availability.insertReason).not.toMatch(/copy still work/i);
  });
  it("falls back to unknown capabilities when the native command is missing", async () => {
    // An older native binary paired with a newer frontend must not break the UI.
    const invoke = vi.fn().mockRejectedValue(new Error("command desktop_capabilities not found"));

    await expect(readDesktopCapabilities(invoke)).resolves.toEqual(UNKNOWN_DESKTOP_CAPABILITIES);
  });

  it("reports the capabilities the native side returns", async () => {
    const invoke = vi.fn().mockResolvedValue({ canCopy: true, canInsert: true });

    await expect(readDesktopCapabilities(invoke)).resolves.toEqual({ canCopy: true, canInsert: true });
    expect(invoke).toHaveBeenCalledWith("desktop_capabilities");
  });
});

describe("desktop compatibility report", () => {
  const supported = {
    mode: "supported",
    capabilities: { canCopy: true, canInsert: true },
    searchAvailable: true,
    requirements: [
      { feature: "search", met: true, unmetPrerequisites: [] },
      { feature: "copy", met: true, unmetPrerequisites: [] },
      { feature: "insert", met: true, unmetPrerequisites: [] },
    ],
  };

  it("reports the structured compatibility the native side returns", async () => {
    const invoke = vi.fn().mockResolvedValue(supported);

    await expect(readDesktopCompatibility(invoke)).resolves.toEqual(supported);
    expect(invoke).toHaveBeenCalledWith("desktop_compatibility");
  });

  it("keeps the named prerequisites for a degraded desktop", async () => {
    const invoke = vi.fn().mockResolvedValue({
      mode: "degraded",
      capabilities: { canCopy: true, canInsert: false },
      searchAvailable: true,
      requirements: [
        { feature: "search", met: true, unmetPrerequisites: [] },
        { feature: "copy", met: true, unmetPrerequisites: [] },
        { feature: "insert", met: false, unmetPrerequisites: ["Hyprland, for the window IPC that confirms the target terminal"] },
      ],
    });

    const report = await readDesktopCompatibility(invoke);

    expect(report.mode).toBe("degraded");
    const insert = report.requirements.find((item) => item.feature === "insert");
    expect(insert?.met).toBe(false);
    // The operator must still be told exactly what is missing, not just "not confirmed".
    expect(insert?.unmetPrerequisites).toContain("Hyprland, for the window IPC that confirms the target terminal");
  });

  it.each([
    null,
    undefined,
    {},
    { mode: "supported" },
    { mode: "elsewhere", capabilities: { canCopy: true, canInsert: true }, searchAvailable: true, requirements: [] },
    { mode: "supported", capabilities: { canCopy: true, canInsert: true }, searchAvailable: true, requirements: [{ feature: "copy", met: "yes", unmetPrerequisites: [] }] },
    { mode: "supported", capabilities: { canCopy: true, canInsert: true }, searchAvailable: true, requirements: [{ feature: "copy", met: true, unmetPrerequisites: [3] }] },
  ])("fails closed to an unknown desktop for malformed report %j", async (value) => {
    const report = await readDesktopCompatibility(vi.fn().mockResolvedValue(value));

    // Failing closed must never claim a capability the native gate would refuse.
    expect(report).toEqual(UNKNOWN_DESKTOP_COMPATIBILITY);
    expect(report.capabilities).toEqual(UNKNOWN_DESKTOP_CAPABILITIES);
    expect(report.searchAvailable).toBe(true);
  });

  it("falls back to unknown when an older native build lacks the command", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("command desktop_compatibility not found"));

    await expect(readDesktopCompatibility(invoke)).resolves.toEqual(UNKNOWN_DESKTOP_COMPATIBILITY);
  });

  it("still reports search as available when every desktop action is unsupported", async () => {
    // Search is bundled: an unsupported desktop must never read as a dead app.
    const invoke = vi.fn().mockResolvedValue({
      mode: "unsupported",
      capabilities: { canCopy: false, canInsert: false },
      searchAvailable: true,
      requirements: [
        { feature: "search", met: true, unmetPrerequisites: [] },
        { feature: "copy", met: false, unmetPrerequisites: ["A Wayland session (this session is not Wayland)"] },
        { feature: "insert", met: false, unmetPrerequisites: ["A Wayland session (this session is not Wayland)"] },
      ],
    });

    const report = await readDesktopCompatibility(invoke);

    expect(report.mode).toBe("unsupported");
    expect(report.searchAvailable).toBe(true);
    expect(report.requirements.find((item) => item.feature === "search")?.met).toBe(true);
  });

  describe("report invariants", () => {
    function report(overrides: Record<string, unknown> = {}) {
      return {
        mode: "supported",
        capabilities: { canCopy: true, canInsert: true },
        searchAvailable: true,
        requirements: [
          { feature: "search", met: true, unmetPrerequisites: [] },
          { feature: "copy", met: true, unmetPrerequisites: [] },
          { feature: "insert", met: true, unmetPrerequisites: [] },
        ],
        ...overrides,
      };
    }

    it("rejects a mode that claims more than the capabilities allow", async () => {
      // The exact fail-closed defect: "Fully supported" while the gate would refuse.
      const lying = report({
        mode: "supported",
        capabilities: { canCopy: false, canInsert: false },
        requirements: [
          { feature: "search", met: true, unmetPrerequisites: [] },
          { feature: "copy", met: false, unmetPrerequisites: ["wl-copy, from the wl-clipboard package"] },
          { feature: "insert", met: false, unmetPrerequisites: ["wtype, on PATH"] },
        ],
      });

      await expect(readDesktopCompatibility(vi.fn().mockResolvedValue(lying)))
        .resolves.toEqual(UNKNOWN_DESKTOP_COMPATIBILITY);
    });

    it("rejects a requirement row that disagrees with the reported capability", async () => {
      const inconsistent = report({
        capabilities: { canCopy: true, canInsert: false },
        mode: "degraded",
        requirements: [
          { feature: "search", met: true, unmetPrerequisites: [] },
          { feature: "copy", met: true, unmetPrerequisites: [] },
          // Says insertion works while the capability says it does not.
          { feature: "insert", met: true, unmetPrerequisites: [] },
        ],
      });

      await expect(readDesktopCompatibility(vi.fn().mockResolvedValue(inconsistent)))
        .resolves.toEqual(UNKNOWN_DESKTOP_COMPATIBILITY);
    });

    it("rejects a report that omits or duplicates a feature row", async () => {
      const missing = report({
        requirements: [
          { feature: "search", met: true, unmetPrerequisites: [] },
          { feature: "copy", met: true, unmetPrerequisites: [] },
        ],
      });
      const duplicated = report({
        requirements: [
          { feature: "search", met: true, unmetPrerequisites: [] },
          { feature: "copy", met: true, unmetPrerequisites: [] },
          { feature: "copy", met: true, unmetPrerequisites: [] },
          { feature: "insert", met: true, unmetPrerequisites: [] },
        ],
      });

      await expect(readDesktopCompatibility(vi.fn().mockResolvedValue(missing)))
        .resolves.toEqual(UNKNOWN_DESKTOP_COMPATIBILITY);
      await expect(readDesktopCompatibility(vi.fn().mockResolvedValue(duplicated)))
        .resolves.toEqual(UNKNOWN_DESKTOP_COMPATIBILITY);
    });

    it("rejects a report that denies bundled search", async () => {
      const noSearch = report({ searchAvailable: false });
      const searchUnmet = report({
        requirements: [
          { feature: "search", met: false, unmetPrerequisites: ["something"] },
          { feature: "copy", met: true, unmetPrerequisites: [] },
          { feature: "insert", met: true, unmetPrerequisites: [] },
        ],
      });

      await expect(readDesktopCompatibility(vi.fn().mockResolvedValue(noSearch)))
        .resolves.toEqual(UNKNOWN_DESKTOP_COMPATIBILITY);
      await expect(readDesktopCompatibility(vi.fn().mockResolvedValue(searchUnmet)))
        .resolves.toEqual(UNKNOWN_DESKTOP_COMPATIBILITY);
    });

    it("rejects a met requirement that still lists prerequisites", async () => {
      const contradictory = report({
        requirements: [
          { feature: "search", met: true, unmetPrerequisites: [] },
          { feature: "copy", met: true, unmetPrerequisites: ["wl-copy, from the wl-clipboard package"] },
          { feature: "insert", met: true, unmetPrerequisites: [] },
        ],
      });

      await expect(readDesktopCompatibility(vi.fn().mockResolvedValue(contradictory)))
        .resolves.toEqual(UNKNOWN_DESKTOP_COMPATIBILITY);
    });

    it("rejects an unavailable action that names nothing to fix", async () => {
      // An empty list is exactly the unactionable "Not confirmed" this replaces.
      const silent = report({
        mode: "degraded",
        capabilities: { canCopy: true, canInsert: false },
        requirements: [
          { feature: "search", met: true, unmetPrerequisites: [] },
          { feature: "copy", met: true, unmetPrerequisites: [] },
          { feature: "insert", met: false, unmetPrerequisites: [] },
        ],
      });

      await expect(readDesktopCompatibility(vi.fn().mockResolvedValue(silent)))
        .resolves.toEqual(UNKNOWN_DESKTOP_COMPATIBILITY);
    });

    it("accepts each genuinely consistent mode", async () => {
      const degraded = report({
        mode: "degraded",
        capabilities: { canCopy: true, canInsert: false },
        requirements: [
          { feature: "search", met: true, unmetPrerequisites: [] },
          { feature: "copy", met: true, unmetPrerequisites: [] },
          { feature: "insert", met: false, unmetPrerequisites: ["wtype, on PATH"] },
        ],
      });
      const unsupported = report({
        mode: "unsupported",
        capabilities: { canCopy: false, canInsert: false },
        requirements: [
          { feature: "search", met: true, unmetPrerequisites: [] },
          { feature: "copy", met: false, unmetPrerequisites: ["A Wayland session (this session is not Wayland)"] },
          { feature: "insert", met: false, unmetPrerequisites: ["A Wayland session (this session is not Wayland)"] },
        ],
      });

      await expect(readDesktopCompatibility(vi.fn().mockResolvedValue(report()))).resolves.toMatchObject({ mode: "supported" });
      await expect(readDesktopCompatibility(vi.fn().mockResolvedValue(degraded))).resolves.toMatchObject({ mode: "degraded" });
      await expect(readDesktopCompatibility(vi.fn().mockResolvedValue(unsupported))).resolves.toMatchObject({ mode: "unsupported" });
    });
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

describe("browser action bridge", () => {
  it("copies with the Clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await createBrowserActions({ clipboard: { writeText } }, document).copy(entry());
    expect(writeText).toHaveBeenCalledWith("hermes help");
  });

  it("falls back to a temporary textarea when Clipboard API copy fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    await createBrowserActions({ clipboard: { writeText } }, document).copy(entry());
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports failure when neither browser copy path succeeds and cleans up the fallback", async () => {
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn().mockReturnValue(false) });
    await expect(createBrowserActions({}, document).copy(entry())).rejects.toThrow(/clipboard/i);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("never inserts from a browser", async () => {
    await expect(createBrowserActions({}, document).insert(entry())).rejects.toThrow(/native Operator Key companion/i);
  });
});

describe("catalog snapshot", () => {
  it("returns the native catalog so both sides agree on command text", async () => {
    // The native gate compares submitted command text against its own catalog exactly.
    // If the UI kept build-time text while the native side applied an operator's sidecar,
    // every copy and insert would fail as a mismatch.
    const snapshot = { entries: [{ id: "a", command: "gh pr list --limit 50" }] };
    const invoke = vi.fn().mockResolvedValue(snapshot);

    await expect(readCatalogSnapshot(invoke)).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenCalledWith("catalog_snapshot");
  });

  it("falls back to the build-time catalog when the native command is unavailable", async () => {
    // An older native binary, or the browser build, must keep working.
    const invoke = vi.fn().mockRejectedValue(new Error("command catalog_snapshot not found"));

    await expect(readCatalogSnapshot(invoke)).resolves.toBeNull();
  });
});
