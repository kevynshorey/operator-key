import { describe, expect, it } from "vitest";
import catalogJson from "../data/catalog.json";
import { parseCatalog } from "./catalog";

describe("catalog boundary", () => {
  it("accepts the checked-in catalog through a typed runtime boundary", () => {
    const result = parseCatalog(catalogJson);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.catalog.entries).toHaveLength(1302);
      expect(result.catalog.total).toBe(1302);
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
