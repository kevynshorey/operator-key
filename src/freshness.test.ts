import { describe, expect, it } from "vitest";
import {
  affectedProducts,
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
