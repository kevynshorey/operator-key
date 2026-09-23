import { invoke } from "@tauri-apps/api/core";
import type { CatalogEntry, InterfaceType } from "./catalog";
import type { OperatorRuntime } from "./runtime";

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
