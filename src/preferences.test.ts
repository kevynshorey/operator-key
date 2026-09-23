import { describe, expect, it } from "vitest";
import { readPreferences, writePreferences, type Preferences } from "./preferences";

describe("validated preferences", () => {
  it("uses safe defaults for missing or malformed storage", () => {
    expect(readPreferences(null)).toEqual({ largeText: false, apprenticeMode: false, favorites: [], recentCopies: [], historyEnabled: false });
    expect(readPreferences('{"largeText":"yes","favorites":[{}]}')).toEqual({ largeText: false, apprenticeMode: false, favorites: [], recentCopies: [], historyEnabled: false });
  });
  it("keeps newest-last favorites and newest-first recent copies within their caps", () => {
    const keys = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ product: "git", command: `${prefix}${i}` }));
    const value: Preferences = { largeText: false, apprenticeMode: false, favorites: keys("f", 205), recentCopies: keys("r", 25), historyEnabled: true };
    const read = readPreferences(writePreferences(value));
    expect(read.favorites).toEqual(keys("f", 205).slice(-200));
    expect(read.recentCopies).toEqual(keys("r", 25).slice(0, 20));
    expect(readPreferences(JSON.stringify({ ...value, recentCopies: [{ product: "git", command: "" }] })).recentCopies).toEqual([]);
    expect(readPreferences(JSON.stringify({ ...value, historyEnabled: false })).recentCopies).toEqual([]);
  });
});
