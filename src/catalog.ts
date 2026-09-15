export const PRODUCTS = ["omarchy", "hermes", "claude-code", "codex"] as const;
export const INTERFACES = ["hotkey", "slash-command", "shell-command", "cli-flag", "menu-action"] as const;
export const TASK_GROUPS = [
  "review-and-verify", "parallel-agents", "context-and-memory", "models-and-performance",
  "debug-and-recover", "sessions-and-navigation", "capture-and-input", "system-and-hardware",
  "configuration", "development", "help-and-reference",
] as const;
export const SAFETY_LEVELS = ["green", "amber", "red"] as const;

export type Product = (typeof PRODUCTS)[number];
export type InterfaceType = (typeof INTERFACES)[number];
export type TaskGroup = (typeof TASK_GROUPS)[number];
export type SafetyLevel = (typeof SAFETY_LEVELS)[number];

export interface Provenance {
  kind: "default" | "override" | "custom" | "official";
  status: "active" | "disabled" | "version-gated";
  source: string;
  version: string;
}

export interface CatalogEntry {
  id: string;
  product: Product;
  product_version: string;
  interface: InterfaceType;
  task_group: TaskGroup;
  category: string;
  command: string;
  canonical_chord: string;
  aliases: string[];
  description: string;
  context: string;
  safety_level: SafetyLevel;
  destructive: boolean;
  available: boolean;
  conflict_ids: string[];
  source: string;
  provenance: Provenance;
}

export interface Conflict {
  id: string;
  canonical_chord: string;
  context: string;
  entry_ids: string[];
}

export interface Catalog {
  schema_version: string;
  generated_at: string;
  host: string;
  versions: Record<Product, string>;
  counts: Record<Product, number>;
  total: number;
  conflicts: Conflict[];
  entries: CatalogEntry[];
}

export type CatalogResult = { ok: true; catalog: Catalog } | { ok: false; error: string };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isEnumValue<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function isProvenance(value: unknown): value is Provenance {
  if (!isRecord(value)) return false;
  return ["default", "override", "custom", "official"].includes(String(value.kind))
    && ["active", "disabled", "version-gated"].includes(String(value.status))
    && typeof value.source === "string"
    && typeof value.version === "string";
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && isEnumValue(PRODUCTS, value.product)
    && typeof value.product_version === "string"
    && isEnumValue(INTERFACES, value.interface)
    && isEnumValue(TASK_GROUPS, value.task_group)
    && typeof value.category === "string"
    && typeof value.command === "string"
    && typeof value.canonical_chord === "string"
    && isStringArray(value.aliases)
    && typeof value.description === "string"
    && typeof value.context === "string"
    && isEnumValue(SAFETY_LEVELS, value.safety_level)
    && typeof value.destructive === "boolean"
    && typeof value.available === "boolean"
    && isStringArray(value.conflict_ids)
    && typeof value.source === "string"
    && isProvenance(value.provenance);
}

function isProductMap(value: unknown, itemType: "string" | "number"): boolean {
  return isRecord(value) && PRODUCTS.every((product) => typeof value[product] === itemType);
}

function isConflict(value: unknown): value is Conflict {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.canonical_chord === "string"
    && typeof value.context === "string"
    && isStringArray(value.entry_ids);
}

export function parseCatalog(value: unknown): CatalogResult {
  if (!isRecord(value)) return { ok: false, error: "Catalog must be an object" };
  if (typeof value.schema_version !== "string") return { ok: false, error: "Catalog is missing schema_version" };
  if (!Array.isArray(value.entries)) return { ok: false, error: "Catalog entries must be an array" };
  if (!value.entries.every(isCatalogEntry)) return { ok: false, error: "Catalog contains an invalid command entry" };
  if (!Array.isArray(value.conflicts) || !value.conflicts.every(isConflict)) return { ok: false, error: "Catalog conflicts are invalid" };
  if (typeof value.generated_at !== "string" || typeof value.host !== "string" || typeof value.total !== "number") return { ok: false, error: "Catalog metadata is invalid" };
  if (!isProductMap(value.versions, "string") || !isProductMap(value.counts, "number")) return { ok: false, error: "Catalog product metadata is invalid" };
  if (value.total !== value.entries.length) return { ok: false, error: "Catalog total does not match its entries" };
  return { ok: true, catalog: value as unknown as Catalog };
}
