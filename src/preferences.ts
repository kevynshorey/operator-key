export interface CommandKey { product: string; command: string }
export interface Preferences {
  largeText: boolean;
  apprenticeMode: boolean;
  favorites: CommandKey[];
  recentCopies: CommandKey[];
  historyEnabled: boolean;
}
export const DEFAULT_PREFERENCES: Preferences = { largeText: false, apprenticeMode: false, favorites: [], recentCopies: [], historyEnabled: false };
const STORAGE_KEY = "operator-key.preferences.v1";
const isCommandKey = (value: unknown): value is CommandKey => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.product === "string" && item.product.length <= 32 && typeof item.command === "string" && item.command.length > 0 && item.command.length <= 512;
};
function parse(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_PREFERENCES;
  const item = value as Record<string, unknown>;
  if (typeof item.largeText !== "boolean" || typeof item.apprenticeMode !== "boolean" || typeof item.historyEnabled !== "boolean" || !Array.isArray(item.favorites) || !Array.isArray(item.recentCopies)) return DEFAULT_PREFERENCES;
  if (!item.favorites.every(isCommandKey) || !item.recentCopies.every(isCommandKey)) return DEFAULT_PREFERENCES;
  const favorites = item.favorites.slice(-200);
  const recentCopies = item.historyEnabled ? item.recentCopies.slice(0, 20) : [];
  return { largeText: item.largeText, apprenticeMode: item.apprenticeMode, favorites, recentCopies, historyEnabled: item.historyEnabled };
}
export function readPreferences(raw: string | null): Preferences {
  if (raw === null) return DEFAULT_PREFERENCES;
  try { return parse(JSON.parse(raw) as unknown); } catch { return DEFAULT_PREFERENCES; }
}
export function writePreferences(value: Preferences): string { return JSON.stringify(parse(value)); }
export function loadPreferences(): Preferences {
  try { return readPreferences(window.localStorage.getItem(STORAGE_KEY)); } catch { return DEFAULT_PREFERENCES; }
}
export function savePreferences(value: Preferences): void {
  try { window.localStorage.setItem(STORAGE_KEY, writePreferences(value)); } catch { /* Private mode/storage denial: retain in-memory behavior. */ }
}
