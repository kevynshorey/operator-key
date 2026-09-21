import { describe, expect, it } from "vitest";
import catalogJson from "../data/catalog.json";
import { parseCatalog } from "./catalog";

describe("catalog boundary", () => {
  it("accepts the checked-in catalog through a typed runtime boundary", () => {
    const result = parseCatalog(catalogJson);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Assert the catalog's INTERNAL consistency rather than a frozen number. A literal
      // count turns every legitimate rebuild (a new adapter, an upstream tool gaining a
      // command) into a red test that says nothing about correctness.
      expect(result.catalog.entries.length).toBeGreaterThan(0);
      expect(result.catalog.total).toBe(result.catalog.entries.length);
      expect(result.catalog.total).toBe(catalogJson.total);
    }
  });

  it("returns a readable error instead of throwing for malformed data", () => {
    expect(parseCatalog({ total: 1, entries: [{ id: "broken" }] })).toEqual({
      ok: false,
      error: "Catalog is missing schema_version",
    });
    expect(() => parseCatalog(null)).not.toThrow();
  });
});
