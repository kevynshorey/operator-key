import { invoke } from "@tauri-apps/api/core";
import type { CatalogEntry, InterfaceType } from "./catalog";
import type { OperatorRuntime } from "./runtime";

const TERMINAL_INTERFACES: ReadonlySet<InterfaceType> = new Set(["shell-command", "cli-flag"]);

export interface ActionAvailability {
  copy: true;
  insert: boolean;
  insertReason?: string;
  warning?: string;
}

export interface OperatorActions {
  copy(entry: CatalogEntry): Promise<void>;
  insert(entry: CatalogEntry): Promise<void>;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type BrowserNavigator = {
  clipboard?: {
    writeText(text: string): Promise<void>;
  };
};

export const WEB_INSERT_REASON = "Install/open the native Operator Key companion to insert into a confirmed terminal.";

export function getActionAvailability(entry: CatalogEntry, runtime: OperatorRuntime = "native"): ActionAvailability {
  if (runtime === "web") {
    return {
      copy: true,
      insert: false,
      insertReason: WEB_INSERT_REASON,
      warning: entry.safety_level === "red" ? "Danger-level (red) command: review carefully. Copy only; terminal insertion is disabled." : undefined,
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
