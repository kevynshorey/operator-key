import { invoke } from "@tauri-apps/api/core";
import type { CatalogEntry, InterfaceType } from "./catalog";
import type { OperatorRuntime } from "./runtime";
import {
  parseShortcutEnvironment,
  UNPROBED_SHORTCUT_ENVIRONMENT,
  type ShortcutEnvironmentReport,
} from "./shortcutEnvironment";

const TERMINAL_INTERFACES: ReadonlySet<InterfaceType> = new Set(["shell-command", "cli-flag"]);

export interface ActionAvailability {
  copy: boolean;
  insert: boolean;
  insertReason?: string;
  warning?: string;
}

export interface OperatorActions {
  copy(entry: CatalogEntry): Promise<void>;
  insert(entry: CatalogEntry): Promise<void>;
}

/**
 * What the host desktop can actually do.
 *
 * Copy and insert are implemented with `wl-copy`, `hyprctl` and `wtype`, which exist only
 * under Wayland, and insertion additionally needs Hyprland's IPC. On any other desktop the
 * operator used to get a raw "could not start hyprctl" process error. The native side
 * reports capability up front so the UI can disable the control and explain it instead.
 */
export interface DesktopCapabilities {
  canCopy: boolean;
  canInsert: boolean;
}

/** Assume nothing until the native side answers. */
export const UNKNOWN_DESKTOP_CAPABILITIES: DesktopCapabilities = { canCopy: false, canInsert: false };

/** A browser tab has its own clipboard and can never insert. */
export const WEB_DESKTOP_CAPABILITIES: DesktopCapabilities = { canCopy: true, canInsert: false };

export const UNSUPPORTED_INSERT_REASON = "Terminal insertion needs a Wayland session running Hyprland. Search and copy still work.";

/** Which Operator Key feature a requirement row describes. */
export type DesktopFeature = "search" | "copy" | "insert";

/** How much of Operator Key this desktop can run. */
export type DesktopMode = "supported" | "degraded" | "unsupported";

/**
 * One feature, whether it is available, and exactly what is missing when it is not.
 *
 * `unmetPrerequisites` is what turns "Not confirmed" into something the operator can act
 * on. It is always empty when `met` is true.
 */
export interface DesktopRequirement {
  feature: DesktopFeature;
  met: boolean;
  unmetPrerequisites: string[];
}

/** The structured compatibility picture the native side reports. */
export interface DesktopCompatibilityReport {
  mode: DesktopMode;
  capabilities: DesktopCapabilities;
  searchAvailable: boolean;
  requirements: DesktopRequirement[];
}

/**
 * Assume no desktop action until the native side answers.
 *
 * Search stays available because it is bundled and never depends on the desktop; claiming
 * otherwise would tell the operator the app is dead when it is not.
 */
export const UNKNOWN_DESKTOP_COMPATIBILITY: DesktopCompatibilityReport = {
  mode: "unsupported",
  capabilities: UNKNOWN_DESKTOP_CAPABILITIES,
  searchAvailable: true,
  requirements: [
    { feature: "search", met: true, unmetPrerequisites: [] },
    { feature: "copy", met: false, unmetPrerequisites: [] },
    { feature: "insert", met: false, unmetPrerequisites: [] },
  ],
};

const DESKTOP_MODES: readonly DesktopMode[] = ["supported", "degraded", "unsupported"];
const DESKTOP_FEATURES: readonly DesktopFeature[] = ["search", "copy", "insert"];

function parseRequirement(value: unknown): DesktopRequirement | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (!DESKTOP_FEATURES.includes(row.feature as DesktopFeature)) return null;
  if (typeof row.met !== "boolean") return null;
  if (!Array.isArray(row.unmetPrerequisites)) return null;
  if (!row.unmetPrerequisites.every((item) => typeof item === "string")) return null;
  return {
    feature: row.feature as DesktopFeature,
    met: row.met,
    unmetPrerequisites: [...(row.unmetPrerequisites as string[])],
  };
}

/** How this copy of the app was installed, which decides how it is upgraded. */
export type InstallKind = "systemPackage" | "userBinary" | "developmentBuild" | "unknown";

const INSTALL_KINDS: InstallKind[] = [
  "systemPackage",
  "userBinary",
  "developmentBuild",
  "unknown",
];

/** What this build is, as the operator can read it off the screen. */
export interface BuildIdentity {
  version: string;
  installKind: InstallKind;
}

/**
 * The honest answer when the native side cannot be reached or does not make sense.
 *
 * An empty version renders as "unknown", never as a plausible number. A wrong version is
 * worse than no version: it is the same false all-clear the catalog freshness work exists
 * to prevent, aimed at the app itself.
 */
export const UNKNOWN_BUILD_IDENTITY: BuildIdentity = {
  version: "",
  installKind: "unknown",
};

/**
 * Read what this build is, so the app can answer the question it asks of everything else.
 *
 * Rebuilds the value field by field rather than passing the payload through: the native
 * side deliberately sends no filesystem path, and reconstructing here means a future
 * change there cannot leak a username into a screenshot by accident.
 */
export async function readBuildIdentity(
  nativeInvoke: Invoke = invoke,
): Promise<BuildIdentity> {
  try {
    const value = await nativeInvoke<unknown>("build_identity");
    if (typeof value !== "object" || value === null) return UNKNOWN_BUILD_IDENTITY;
    const identity = value as Record<string, unknown>;

    if (typeof identity.version !== "string" || !identity.version.trim()) {
      return UNKNOWN_BUILD_IDENTITY;
    }
    if (!INSTALL_KINDS.includes(identity.installKind as InstallKind)) {
      return UNKNOWN_BUILD_IDENTITY;
    }

    return {
      version: identity.version,
      installKind: identity.installKind as InstallKind,
    };
  } catch {
    return UNKNOWN_BUILD_IDENTITY;
  }
}

/**
 * Read the structured desktop compatibility report from the native side.
 *
 * Fails closed to {@link UNKNOWN_DESKTOP_COMPATIBILITY} for any malformed payload, for an
 * older native build without the command, and — critically — for any internally
 * inconsistent report. Type-checking alone is not enough: a payload whose mode or
 * requirement rows disagree with its capabilities could render "Fully supported" for a
 * desktop whose native gate would refuse the action, so consistency is enforced here.
 */
export async function readDesktopCompatibility(
  nativeInvoke: Invoke = invoke,
): Promise<DesktopCompatibilityReport> {
  try {
    const value = await nativeInvoke<unknown>("desktop_compatibility");
    if (typeof value !== "object" || value === null) return UNKNOWN_DESKTOP_COMPATIBILITY;
    const report = value as Record<string, unknown>;

    if (!DESKTOP_MODES.includes(report.mode as DesktopMode)) return UNKNOWN_DESKTOP_COMPATIBILITY;
    if (!Array.isArray(report.requirements)) return UNKNOWN_DESKTOP_COMPATIBILITY;
    // Search is bundled and desktop-independent: a report denying it is not trustworthy.
    if (report.searchAvailable !== true) return UNKNOWN_DESKTOP_COMPATIBILITY;

    const capabilities = report.capabilities as Record<string, unknown> | undefined;
    if (typeof capabilities !== "object" || capabilities === null
      || typeof capabilities.canCopy !== "boolean" || typeof capabilities.canInsert !== "boolean") {
      return UNKNOWN_DESKTOP_COMPATIBILITY;
    }
    const { canCopy, canInsert } = capabilities as { canCopy: boolean; canInsert: boolean };

    // The mode must not claim more than the capabilities allow.
    const expectedMode: DesktopMode = canCopy && canInsert
      ? "supported"
      : canCopy || canInsert ? "degraded" : "unsupported";
    if (report.mode !== expectedMode) return UNKNOWN_DESKTOP_COMPATIBILITY;

    const byFeature = new Map<DesktopFeature, DesktopRequirement>();
    for (const row of report.requirements) {
      const parsed = parseRequirement(row);
      if (!parsed) return UNKNOWN_DESKTOP_COMPATIBILITY;
      // Exactly one row per feature: a duplicate makes the rendered answer ambiguous.
      if (byFeature.has(parsed.feature)) return UNKNOWN_DESKTOP_COMPATIBILITY;
      // A met feature has nothing to install; an unmet one must say what is missing,
      // otherwise it is the unactionable status this report exists to replace.
      if (parsed.met && parsed.unmetPrerequisites.length > 0) return UNKNOWN_DESKTOP_COMPATIBILITY;
      if (!parsed.met && parsed.unmetPrerequisites.length === 0) return UNKNOWN_DESKTOP_COMPATIBILITY;
      byFeature.set(parsed.feature, parsed);
    }

    const search = byFeature.get("search");
    const copy = byFeature.get("copy");
    const insert = byFeature.get("insert");
    if (!search || !copy || !insert) return UNKNOWN_DESKTOP_COMPATIBILITY;
    if (!search.met) return UNKNOWN_DESKTOP_COMPATIBILITY;
    // Each action row must agree with the capability the native gate actually enforces.
    if (copy.met !== canCopy || insert.met !== canInsert) return UNKNOWN_DESKTOP_COMPATIBILITY;

    return {
      mode: report.mode as DesktopMode,
      capabilities: { canCopy, canInsert },
      searchAvailable: true,
      requirements: [search, copy, insert],
    };
  } catch {
    // An older native build without this command must not break the UI.
    return UNKNOWN_DESKTOP_COMPATIBILITY;
  }
}


/**
 * The catalog the native side will actually enforce.
 *
 * The frontend imports `data/catalog.json` at build time. The native side may have applied
 * an operator's sidecar catalog on top of it. Those must agree: the native gate matches the
 * submitted command text against its own catalog exactly, so a UI rendering build-time text
 * against a sidecar-updated native catalog would fail every copy and insert as a mismatch.
 *
 * Returns null when there is no native side or the command is unavailable, in which case
 * the caller keeps the build-time catalog it already has.
 */
export async function readCatalogSnapshot(nativeInvoke: Invoke = invoke): Promise<unknown | null> {
  try {
    return await nativeInvoke<unknown>("catalog_snapshot");
  } catch {
    return null;
  }
}

export async function readDesktopCapabilities(
  nativeInvoke: Invoke = invoke,
): Promise<DesktopCapabilities> {
  try {
    const value = await nativeInvoke<unknown>("desktop_capabilities");
    if (typeof value !== "object" || value === null || !("canCopy" in value) || !("canInsert" in value)
      || typeof value.canCopy !== "boolean" || typeof value.canInsert !== "boolean") {
      return UNKNOWN_DESKTOP_CAPABILITIES;
    }
    return { canCopy: value.canCopy, canInsert: value.canInsert };
  } catch {
    // An older native build without this command must not break the UI: fall back to
    // "unknown", which disables the affected controls rather than promising them.
    return UNKNOWN_DESKTOP_CAPABILITIES;
  }
}

/**
 * Advisory snapshot of the live shortcut environment (Hyprland binds + keyboard
 * hints). Validation lives in parseShortcutEnvironment and fails closed; a missing
 * command on an older native build degrades to "unavailable", never an error. This
 * report gates NOTHING — search, copy, and insert never consult it.
 */
export async function readShortcutEnvironment(
  nativeInvoke: Invoke = invoke,
): Promise<ShortcutEnvironmentReport> {
  try {
    const value = await nativeInvoke<unknown>("shortcut_environment");
    return parseShortcutEnvironment(value);
  } catch {
    return UNPROBED_SHORTCUT_ENVIRONMENT;
  }
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type BrowserNavigator = {
  clipboard?: {
    writeText(text: string): Promise<void>;
  };
};

export const WEB_INSERT_REASON = "Install/open the native Operator Key companion to insert into a confirmed terminal.";

export function getActionAvailability(
  entry: CatalogEntry,
  runtime: OperatorRuntime = "native",
  capabilities: DesktopCapabilities = { canCopy: true, canInsert: true },
): ActionAvailability {
  if (runtime === "web") {
    return {
      copy: true,
      insert: false,
      insertReason: WEB_INSERT_REASON,
      warning: entry.safety_level === "red" ? "Danger-level (red) command: review carefully. Copy only; terminal insertion is disabled." : undefined,
    };
  }
  if (!capabilities.canCopy) {
    return {
      copy: false,
      insert: false,
      insertReason: "Native clipboard needs Wayland and wl-copy. Search remains available; check desktop requirements in Settings.",
      warning: entry.safety_level === "red" ? "Danger-level (red) command: review carefully." : undefined,
    };
  }
  if (entry.safety_level === "red") {
    return {
      copy: true,
      insert: false,
      insertReason: "Danger-level entries are copy-only.",
      warning: "Danger-level (red) command: review carefully. Copy only; terminal insertion is disabled.",
    };
  }
  if (!entry.available) {
    return { copy: true, insert: false, insertReason: "This entry is unavailable in the detected setup." };
  }
  if (!TERMINAL_INTERFACES.has(entry.interface)) {
    return { copy: true, insert: false, insertReason: "Insertion requires a terminal-compatible interface." };
  }
  if (!capabilities.canInsert) {
    return { copy: true, insert: false, insertReason: UNSUPPORTED_INSERT_REASON };
  }
  return { copy: true, insert: true };
}

export function createNativeActions(nativeInvoke: Invoke = invoke): OperatorActions {
  const payload = (entry: CatalogEntry) => ({ entryId: entry.id, command: entry.command });
  return {
    copy: (entry) => nativeInvoke<void>("copy_catalog_command", payload(entry)),
    insert: (entry) => nativeInvoke<void>("insert_catalog_command", payload(entry)),
  };
}

export function createBrowserActions(
  browserNavigator: BrowserNavigator = navigator,
  browserDocument: Document = document,
): OperatorActions {
  return {
    async copy(entry) {
      try {
        if (!browserNavigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await browserNavigator.clipboard.writeText(entry.command);
        return;
      } catch {
        const textarea = browserDocument.createElement("textarea");
        textarea.value = entry.command;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        browserDocument.body.append(textarea);
        textarea.select();
        try {
          if (typeof browserDocument.execCommand !== "function" || !browserDocument.execCommand("copy")) {
            throw new Error("Clipboard copy is unavailable in this browser.");
          }
        } finally {
          textarea.remove();
        }
      }
    },
    async insert() {
      throw new Error(WEB_INSERT_REASON);
    },
  };
}

export const nativeActions = createNativeActions();
