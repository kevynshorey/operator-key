import { invoke } from "@tauri-apps/api/core";
import type { CatalogEntry, InterfaceType } from "./catalog";

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

export function getActionAvailability(entry: CatalogEntry): ActionAvailability {
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

export const nativeActions = createNativeActions();
