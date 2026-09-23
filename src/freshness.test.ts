import { describe, expect, it } from "vitest";
import {
  affectedProducts,
  entryVersionVerdict,
  highestLevel,
  parseFreshness,
  summarizeFreshness,
  type FreshnessReport,
} from "./freshness";

const NOW = new Date("2026-09-21T12:00:00Z");

function report(overrides: Partial<FreshnessReport> = {}): FreshnessReport {
  return {
    schema_version: "1.0.0",
    checked_at: "2026-09-21T06:00:00Z",
    offline: false,
    reachable: true,
    catalog_generated_at: "2026-09-20T12:00:00Z",
    products: {
      hermes: {
        installed: "0.21.3",
        drift: "unknown",
        upstream_status: "no-public-feed",
        catalog_built_from: "0.21.3",
        catalog_matches_installed: true,
      },
    },
    docs: {},
    ...overrides,
  };
}

describe("freshness summary", () => {
  it("says plainly when no check has ever run", () => {
    const summary = summarizeFreshness(undefined, NOW);
    expect(summary.neverChecked).toBe(true);
    expect(summary.notices[0].headline).toMatch(/never checked/i);
  });

  it("stays silent when everything is in sync and recent", () => {
    expect(summarizeFreshness(report(), NOW).notices).toHaveLength(0);
    expect(highestLevel(summarizeFreshness(report(), NOW))).toBe("none");
  });

  // The highest-stakes case: what is on screen may not be what is installed.
  it("raises attention when the catalog no longer matches the installed tools", () => {
    const summary = summarizeFreshness(
      report({
        products: {
          "claude-code": {
            installed: "2.1.278",
            drift: "current",
            upstream_status: "ok",
            catalog_built_from: "2.1.272",
            catalog_matches_installed: false,
          },
        },
      }),
      NOW,
    );
    expect(highestLevel(summary)).toBe("attention");
    expect(summary.notices[0].headline).toMatch(/out of date for claude-code/i);
    expect(affectedProducts(summary).has("claude-code")).toBe(true);
  });

  // Being a patch behind is worth knowing, not worth alarming over: a banner that cries
  // wolf on every release teaches operators to dismiss the one that matters.
  it("treats being behind upstream as information, not alarm", () => {
    const summary = summarizeFreshness(
      report({
        products: {
          codex: {
            installed: "0.154.0",
            latest: "rust-v0.155.1",
            drift: "behind",
            upstream_status: "ok",
            catalog_built_from: "0.154.0",
            catalog_matches_installed: true,
          },
        },
      }),
      NOW,
    );
    expect(highestLevel(summary)).toBe("info");
    expect(summary.notices[0].headline).toMatch(/1 tool behind/i);
  });

  // The quiet rot: same version, changed meaning.
  it("raises attention when documentation changed without a version bump", () => {
    const summary = summarizeFreshness(
      report({
        docs: {
          claude_commands: {
            product: "claude-code",
            url: "https://code.claude.com/docs/en/commands.md",
            status: "changed",
          },
        },
      }),
      NOW,
    );
    expect(highestLevel(summary)).toBe("attention");
    expect(summary.notices.some((n) => /documentation changed/i.test(n.headline))).toBe(true);
  });

  it("does not repeat a product when several of its docs changed", () => {
    const summary = summarizeFreshness(
      report({
        docs: {
          a: { product: "claude-code", url: "u1", status: "changed" },
          b: { product: "claude-code", url: "u2", status: "changed" },
        },
      }),
      NOW,
    );
    const notice = summary.notices.find((n) => /documentation changed/i.test(n.headline))!;
    expect(notice.products).toEqual(["claude-code"]);
  });

  it("mentions catalog age only once it is genuinely old", () => {
    const fresh = summarizeFreshness(report({ catalog_generated_at: "2026-09-18T12:00:00Z" }), NOW);
    expect(fresh.notices).toHaveLength(0);

    const old = summarizeFreshness(report({ catalog_generated_at: "2026-08-20T12:00:00Z" }), NOW);
    expect(old.notices[0].headline).toMatch(/32 days old/i);
  });

  it("does not nag about age when it already has something specific to say", () => {
    const summary = summarizeFreshness(
      report({
        catalog_generated_at: "2026-08-01T12:00:00Z",
        products: {
          codex: {
            installed: "0.155.1",
            drift: "current",
            upstream_status: "ok",
            catalog_built_from: "0.154.0",
            catalog_matches_installed: false,
          },
        },
      }),
      NOW,
    );
    expect(summary.notices.every((n) => !/days old/i.test(n.headline))).toBe(true);
  });

  // Silence after a failed check would read as "all clear" when nothing was learned.
  it("admits when the last check could not reach anything", () => {
    const summary = summarizeFreshness(report({ reachable: false }), NOW);
    expect(summary.notices.some((n) => /could not reach/i.test(n.headline))).toBe(true);
  });

  it("does not report unreachable sources for a deliberate offline check", () => {
    const summary = summarizeFreshness(report({ reachable: false, offline: true }), NOW);
    expect(summary.notices.some((n) => /could not reach/i.test(n.headline))).toBe(false);
  });

  it("reports how long ago the check and the catalog build happened", () => {
    const summary = summarizeFreshness(report(), NOW);
    expect(summary.daysSinceCheck).toBe(0);
    expect(summary.catalogAgeDays).toBe(1);
  });

  it("never reports negative ages from clock skew", () => {
    const summary = summarizeFreshness(report({ catalog_generated_at: "2026-10-01T12:00:00Z" }), NOW);
    expect(summary.catalogAgeDays).toBe(0);
  });

  // A fresh clone has no freshness.json at all. Every "no usable report" shape must land
  // on the honest "never checked" notice rather than silently implying currency.
  it("treats every absent-report shape as never checked", () => {
    for (const value of [undefined, null, {}, { nonsense: true }, "", 0]) {
      const summary = summarizeFreshness(parseFreshness(value), NOW);
      expect(summary.neverChecked).toBe(true);
      expect(summary.notices[0].headline).toMatch(/never checked/i);
    }
  });

  // Found in the live app: an offline run overwrote the previous report and erased known
  // drift, so a stale catalog looked clean. Offline must not destroy what we learned.
  it("keeps reporting drift found by the last online check while offline", () => {
    const summary = summarizeFreshness(
      report({
        offline: true,
        reachable: false,
        products: {
          codex: {
            installed: "0.154.0",
            latest: "rust-v0.155.1",
            drift: "unknown",
            upstream_status: "offline",
            catalog_built_from: "0.154.0",
            catalog_matches_installed: true,
            last_known_drift: "behind",
            last_known_at: "2026-09-21T06:00:00Z",
          },
        },
      }),
      NOW,
    );
    const notice = summary.notices.find((n) => /behind upstream/i.test(n.headline));
    expect(notice).toBeDefined();
    expect(notice!.detail).toMatch(/as of the last online check/i);
  });

  it("does not hedge the wording when the drift is freshly confirmed", () => {
    const summary = summarizeFreshness(
      report({
        products: {
          codex: {
            installed: "0.154.0",
            latest: "rust-v0.155.1",
            drift: "behind",
            upstream_status: "ok",
            catalog_built_from: "0.154.0",
            catalog_matches_installed: true,
          },
        },
      }),
      NOW,
    );
    const notice = summary.notices.find((n) => /behind upstream/i.test(n.headline))!;
    expect(notice.detail).toMatch(/newer releases exist/i);
    expect(notice.detail).not.toMatch(/as of the last online check/i);
  });

  // A downloaded GitHub repo ships someone else's catalog. On a machine with none of the
  // tools installed, every entry describes a computer the operator has never seen, and
  // saying "your catalog is out of date" would be actively misleading.
  it("says plainly when the catalog describes a different machine", () => {
    const summary = summarizeFreshness(
      report({
        products: {
          omarchy: {
            installed: "unknown",
            installed_here: false,
            drift: "unknown",
            upstream_status: "not-installed",
            catalog_built_from: "4.0.3-1",
            catalog_matches_installed: false,
          },
          hermes: {
            installed: "unknown",
            installed_here: false,
            drift: "unknown",
            upstream_status: "not-installed",
            catalog_built_from: "0.21.3",
            catalog_matches_installed: false,
          },
        },
      }),
      NOW,
    );
    expect(highestLevel(summary)).toBe("attention");
    expect(summary.notices).toHaveLength(1);
    expect(summary.notices[0].headline).toMatch(/describes a different machine/i);
    expect(summary.notices[0].detail).toMatch(/build_catalog/i);
  });

  it("does not call an absent tool out of date", () => {
    const summary = summarizeFreshness(
      report({
        products: {
          hermes: {
            installed: "0.21.3",
            drift: "unknown",
            upstream_status: "no-public-feed",
            catalog_built_from: "0.21.3",
            catalog_matches_installed: true,
          },
          omarchy: {
            installed: "unknown",
            installed_here: false,
            drift: "unknown",
            upstream_status: "not-installed",
            catalog_built_from: "4.0.3-1",
            catalog_matches_installed: false,
          },
        },
      }),
      NOW,
    );
    expect(summary.notices.some((n) => /out of date for omarchy/i.test(n.headline))).toBe(false);
    const notice = summary.notices.find((n) => /not installed here/i.test(n.headline));
    expect(notice).toBeDefined();
    expect(notice!.level).toBe("info");
  });

  it("does not report upstream drift for a tool that is not installed", () => {
    const summary = summarizeFreshness(
      report({
        products: {
          hermes: {
            installed: "0.21.3",
            drift: "unknown",
            upstream_status: "no-public-feed",
            catalog_built_from: "0.21.3",
            catalog_matches_installed: true,
          },
          codex: {
            installed: "unknown",
            installed_here: false,
            latest: "rust-v0.155.1",
            drift: "behind",
            upstream_status: "not-installed",
            catalog_built_from: "0.154.0",
            catalog_matches_installed: false,
          },
        },
      }),
      NOW,
    );
    expect(summary.notices.some((n) => /behind upstream/i.test(n.headline))).toBe(false);
  });
});

describe("per-entry version verdict", () => {
  it("says nothing when the entry's version is the one installed", () => {
    const verdict = entryVersionVerdict("hermes", "0.21.3", report());

    // A command that matches the machine needs no annotation. Marking every entry would
    // make the one that genuinely disagrees indistinguishable from the rest.
    expect(verdict).toBeUndefined();
  });

  it("warns when the entry was catalogued from a version that is not installed now", () => {
    const verdict = entryVersionVerdict(
      "hermes",
      "0.21.3",
      report({
        products: {
          hermes: {
            installed: "0.22.0",
            drift: "unknown",
            upstream_status: "no-public-feed",
            catalog_built_from: "0.21.3",
            catalog_matches_installed: false,
          },
        },
      }),
    );

    expect(verdict?.level).toBe("attention");
    // It must name BOTH versions: "may not match" without numbers is unactionable.
    expect(verdict?.detail).toContain("0.21.3");
    expect(verdict?.detail).toContain("0.22.0");
  });

  it("states the tool is absent rather than implying the command is stale", () => {
    const verdict = entryVersionVerdict(
      "hermes",
      "0.21.3",
      report({
        products: {
          hermes: {
            installed: "unknown",
            drift: "unknown",
            upstream_status: "not-installed",
            catalog_built_from: "0.21.3",
            catalog_matches_installed: false,
            installed_here: false,
          },
        },
      }),
    );

    // Skill rule 39: "not installed here" is not "out of date". Saying a version mismatch
    // for a tool the operator never had sends them to upgrade something absent.
    expect(verdict?.level).toBe("info");
    expect(verdict?.detail).toMatch(/not installed/i);
    expect(verdict?.detail).not.toMatch(/out of date|behind|regenerate/i);
  });

  it("stays quiet about a product the report never mentions", () => {
    // An unknown product is not evidence of a mismatch. Silence is the honest answer.
    expect(entryVersionVerdict("git", "2.55.0", report())).toBeUndefined();
  });

  it("stays quiet when there is no report at all", () => {
    expect(entryVersionVerdict("hermes", "0.21.3", undefined)).toBeUndefined();
  });

  it("does not warn merely because the tool is behind upstream", () => {
    // Being behind upstream does not make the catalogued command wrong: it still matches
    // what is installed. Flagging it per entry is the nagging that breeds banner blindness.
    const verdict = entryVersionVerdict(
      "hermes",
      "0.21.3",
      report({
        products: {
          hermes: {
            installed: "0.21.3",
            latest: "0.30.0",
            drift: "behind",
            upstream_status: "ok",
            catalog_built_from: "0.21.3",
            catalog_matches_installed: true,
          },
        },
      }),
    );

    expect(verdict).toBeUndefined();
  });

  it("treats an empty entry version as unknown rather than mismatched", () => {
    const verdict = entryVersionVerdict(
      "hermes",
      "",
      report({
        products: {
          hermes: {
            installed: "0.22.0",
            drift: "unknown",
            upstream_status: "no-public-feed",
            catalog_built_from: "0.21.3",
            catalog_matches_installed: false,
          },
        },
      }),
    );

    // With no version on the entry there is nothing to compare; inventing a verdict from
    // the product-level record would attribute a mismatch this entry never claimed.
    expect(verdict).toBeUndefined();
  });
  it("survives a malformed product record instead of crashing the panel", () => {
    // parseFreshness validates the envelope but CASTS products, so a record missing
    // `installed` reaches the verdict. Reading .trim() off it threw a TypeError and took
    // down the whole detail panel — an advisory note must never be able to do that.
    // The report is machine-written and can be truncated, hand-edited, or half-written by
    // an interrupted check, so malformed shapes are reachable in practice.
    const malformed = parseFreshness({
      checked_at: "2026-09-21T06:00:00Z",
      products: { hermes: {} },
    });

    expect(() => entryVersionVerdict("hermes", "0.21.3", malformed)).not.toThrow();
    expect(entryVersionVerdict("hermes", "0.21.3", malformed)).toBeUndefined();
  });

  it("ignores a product record whose fields are the wrong type", () => {
    const malformed = parseFreshness({
      checked_at: "2026-09-21T06:00:00Z",
      products: { hermes: { installed: 42, installed_here: "yes" } },
    });

    expect(() => entryVersionVerdict("hermes", "0.21.3", malformed)).not.toThrow();
    expect(entryVersionVerdict("hermes", "0.21.3", malformed)).toBeUndefined();
  });

  it("still reports absence when a malformed record says the tool is missing", () => {
    // installed_here is the one field that must survive an otherwise-unusable record:
    // it is the difference between "not installed" and a false staleness claim.
    const partial = parseFreshness({
      checked_at: "2026-09-21T06:00:00Z",
      products: { hermes: { installed_here: false } },
    });

    const verdict = entryVersionVerdict("hermes", "0.21.3", partial);
    expect(verdict?.level).toBe("info");
    expect(verdict?.detail).toMatch(/not installed/i);
  });
});

describe("hostile freshness documents", () => {
  /**
   * The report is a machine-written file on disk. It can be truncated by an interrupted
   * check, hand-edited, or carry shapes the writer never intended. None of that may crash
   * the panel or produce a claim the data does not support, so the parser is exercised
   * against deliberately hostile shapes rather than only well-formed ones.
   */
  const hostile: [string, unknown][] = [
    ["array as the products map", []],
    ["array as a record", { hermes: [] }],
    ["function as a record", { hermes: () => undefined }],
    ["Date as a record", { hermes: new Date() }],
    ["null-prototype record", { hermes: Object.assign(Object.create(null), { installed: "1.0" }) }],
    ["boxed String installed", { hermes: { installed: new String("1.0") } }],
    ["empty installed", { hermes: { installed: "" } }],
    ["whitespace-only installed", { hermes: { installed: "   " } }],
    ["installed_here truthy but not true", { hermes: { installed_here: 1 } }],
    ["upstream_status in the wrong case", { hermes: { upstream_status: "NOT-INSTALLED" } }],
    ["__proto__ key", JSON.parse('{"__proto__":{"polluted":true},"hermes":{"installed":"1.0"}}')],
    ["constructor key", { constructor: { installed: "x" }, hermes: { installed: "1.0" } }],
    ["numeric keys", { 0: { installed: "1.0" }, hermes: { installed: "1.0" } }],
    ["nulls in optional fields", { hermes: { installed: "1.0", drift: null, upstream_status: null, latest: null } }],
    ["wrong types throughout", { hermes: { installed: "1.0", drift: 42, upstream_status: [], catalog_matches_installed: "no", last_known_drift: {} } }],
  ];

  for (const [name, products] of hostile) {
    it(`neither crashes nor invents a claim: ${name}`, () => {
      const parsed = parseFreshness({ checked_at: "2026-09-21T06:00:00Z", products });

      expect(() => entryVersionVerdict("hermes", "0.21.3", parsed)).not.toThrow();
      expect(() => summarizeFreshness(parsed, NOW)).not.toThrow();
      expect(() => highestLevel(summarizeFreshness(parsed, NOW))).not.toThrow();

      // Whatever it decides to say must not leak the shape of the bad data.
      const verdict = entryVersionVerdict("hermes", "0.21.3", parsed);
      if (verdict) expect(verdict.detail).not.toMatch(/undefined|NaN|\[object/);
      for (const notice of summarizeFreshness(parsed, NOW).notices) {
        expect(`${notice.headline} ${notice.detail}`).not.toMatch(/undefined|NaN|\[object/);
      }
    });
  }

  it("cannot smuggle a record in through the prototype chain", () => {
    // Assigning a key named __proto__ onto a plain {} invokes the prototype setter, so the
    // map itself inherits the attacker's object. A later lookup for a product named after
    // any key on it would then find a record nobody wrote. The map is null-prototype and
    // lookups are own-key only, so an unwritten product stays absent.
    const parsed = parseFreshness({
      checked_at: "2026-09-21T06:00:00Z",
      products: JSON.parse('{"__proto__":{"installed":"9.9.9","installed_here":true}}'),
    });

    expect(parsed?.products.installed).toBeUndefined();
    expect(Object.getPrototypeOf(parsed?.products ?? {})).toBeNull();

    // And nothing inherited may surface as a verdict about a real catalog product.
    expect(entryVersionVerdict("installed", "0.21.3", parsed)).toBeUndefined();
  });

  it("does not pollute Object.prototype through a __proto__ key", () => {
    parseFreshness({
      checked_at: "2026-09-21T06:00:00Z",
      products: JSON.parse('{"__proto__":{"polluted":true}}'),
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("drops a record that throws on property access", () => {
    // Unreachable from the JSON module the app loads (JSON has no getters), but the
    // parser is total so no caller has to reason about whether its input is exotic.
    const evil = { hermes: {} as Record<string, unknown> };
    Object.defineProperty(evil.hermes, "installed", {
      get() { throw new Error("hostile getter"); },
      enumerable: true,
    });

    expect(() => parseFreshness({ checked_at: "2026-09-21T06:00:00Z", products: evil })).not.toThrow();
    expect(parseFreshness({ checked_at: "2026-09-21T06:00:00Z", products: evil })?.products.hermes).toBeUndefined();
  });
});

describe("freshness parsing", () => {
  it("rejects malformed documents rather than half-trusting them", () => {
    expect(parseFreshness(undefined)).toBeUndefined();
    expect(parseFreshness(null)).toBeUndefined();
    expect(parseFreshness({})).toBeUndefined();
    expect(parseFreshness({ checked_at: "x" })).toBeUndefined();
    expect(parseFreshness("nope")).toBeUndefined();
  });

  it("accepts a well-formed document", () => {
    const parsed = parseFreshness(report());
    expect(parsed?.checked_at).toBe("2026-09-21T06:00:00Z");
  });

  it("defaults missing docs to empty rather than failing", () => {
    const parsed = parseFreshness({ checked_at: "2026-09-21T06:00:00Z", products: {} });
    expect(parsed?.docs).toEqual({});
  });
});
