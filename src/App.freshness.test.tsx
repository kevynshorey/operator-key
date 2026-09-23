import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import catalogJson from "../data/catalog.json";
import stylesheet from "./styles.css?raw";
import App from "./App";

const IN_SYNC = {
  schema_version: "1.0.0",
  checked_at: new Date().toISOString(),
  offline: false,
  reachable: true,
  catalog_generated_at: new Date().toISOString(),
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
};

/** A catalog built from versions that are no longer installed: the loud, "attention" tier. */
const STALE_CATALOG = {
  ...IN_SYNC,
  products: {
    hermes: {
      installed: "0.22.0",
      drift: "unknown",
      upstream_status: "no-public-feed",
      catalog_built_from: "0.21.3",
      catalog_matches_installed: false,
    },
  },
};

describe("per-entry version mismatch", () => {
  /**
   * The app selects from ranked results, not catalog order, so the entry on screen is
   * discovered from the rendered panel rather than assumed to be entries[0]. Asserting
   * against a hardcoded entry would silently stop testing the real surface the day
   * ranking changes.
   */
  function shownEntry(): { product: string; product_version: string } {
    const { unmount } = render(<App freshness={IN_SYNC} />);
    const detail = screen.getByRole("article");
    const command = within(detail).getByRole("heading", { level: 2 }).textContent ?? "";
    unmount();

    const match = (catalogJson as { entries: { product: string; product_version: string; command: string }[] })
      .entries.find((candidate) => candidate.command === command.trim());
    if (!match) throw new Error(`no catalog entry for rendered command: ${command}`);
    return match;
  }

  it("marks a command whose catalogued version is not the one installed", () => {
    // The catalog ships from whichever machine built it, so a clone can display commands
    // extracted from a version the reader does not have. The banner says the catalog is
    // stale overall; this says WHICH command is affected, at the moment it is read.
    const entry = shownEntry();

    render(
      <App
        freshness={{
          ...IN_SYNC,
          products: {
            [entry.product]: {
              installed: "99.99.99",
              drift: "unknown",
              upstream_status: "no-public-feed",
              catalog_built_from: entry.product_version,
              catalog_matches_installed: false,
            },
          },
        }}
      />,
    );

    const detail = screen.getByRole("article");
    const note = within(detail).getByRole("note", { name: /version mismatch/i });
    expect(note).toHaveTextContent(entry.product_version);
    expect(note).toHaveTextContent("99.99.99");
  });

  it("leaves a matching command unmarked", () => {
    const entry = shownEntry();

    render(
      <App
        freshness={{
          ...IN_SYNC,
          products: {
            [entry.product]: {
              installed: entry.product_version,
              drift: "unknown",
              upstream_status: "no-public-feed",
              catalog_built_from: entry.product_version,
              catalog_matches_installed: true,
            },
          },
        }}
      />,
    );

    const detail = screen.getByRole("article");
    expect(within(detail).queryByRole("note", { name: /version mismatch/i })).toBeNull();
  });
});

describe("detail card layout contract", () => {
  it("gives every stacked detail element an explicit flex order", () => {
    // .detail-card is a flex column whose children are positioned by explicit `order`
    // rules, not DOM order. A new child without one silently defaults to order 0 and
    // jumps ABOVE the command heading — so a warning about a command renders before the
    // command is named. jsdom does not lay out, so no rendering test can see this; it was
    // caught only by looking at a real browser. This asserts the rule instead.
    // Collect every class named by a rule that sets `order`, including comma-separated
    // selector lists like `.operator-shell .a, .operator-shell .b { order:4; }`.
    const ordered = new Set<string>();
    for (const rule of stylesheet.matchAll(/([^{}]+)\{[^}]*\border\s*:/g)) {
      for (const cls of rule[1].matchAll(/\.operator-shell\s+\.([\w-]+)/g)) {
        ordered.add(cls[1]);
      }
    }

    // Every element the detail card stacks must be named by one of those rules.
    for (const child of ["detail-header", "command-context", "detail-description", "version-verdict", "conflict-panel", "action-panel", "key-trace", "telemetry-grid"]) {
      expect(ordered, `"${child}" has no explicit flex order and will jump to the top`).toContain(child);
    }
  });
});

describe("freshness banner", () => {
  it("keeps the standing advisory out of the transient alert channel", () => {
    // A persistent banner must not claim role="alert". That channel belongs to transient,
    // action-triggered messages ("clipboard unavailable", "this command is red"), and a
    // standing advisory sitting in it both steals those announcements from assistive tech
    // and makes getByRole("alert") ambiguous for every other test. The banner's own source
    // comment says exactly this; the attention tier contradicted it.
    //
    // Regression: with a real data/freshness.json present, five unrelated App tests failed
    // because this banner answered their alert queries. CI never saw it, since the report
    // is gitignored machine state and absent on a runner.
    render(<App freshness={STALE_CATALOG} />);

    const banner = screen.getByRole("note", { name: /catalog freshness/i });
    expect(banner).toHaveTextContent(/out of date/i);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays out of the way when the catalog is in sync", () => {
    render(<App freshness={IN_SYNC} />);
    expect(screen.queryByLabelText(/catalog freshness/i)).toBeNull();
  });

  // The app already uses role="status" to announce actions ("Copied"). A standing
  // advisory must not squat in that channel or it steals real announcements.
  it("does not occupy the action-feedback live region", () => {
    render(<App freshness={null} />);
    const statuses = screen.queryAllByRole("status");
    for (const status of statuses) {
      expect(status.getAttribute("aria-label")).not.toMatch(/catalog freshness/i);
    }
  });

  it("tells the operator when nothing has ever been checked", () => {
    render(<App freshness={null} />);
    const banner = screen.getByLabelText(/catalog freshness/i);
    expect(within(banner).getByText(/never checked for updates/i, { selector: "b" })).toBeTruthy();
  });

  // The loudest case, and the one that undermines every command on screen.
  it("says loudly when the catalog no longer matches installed tools", () => {
    render(
      <App
        freshness={{
          ...IN_SYNC,
          products: {
            "claude-code": {
              installed: "2.1.278",
              drift: "current",
              upstream_status: "ok",
              catalog_built_from: "2.1.272",
              catalog_matches_installed: false,
            },
          },
        }}
      />,
    );
    // Loud in wording and styling, but still role="note": see the FreshnessBanner comment.
    // A standing advisory in the alert channel answers other surfaces' alert queries.
    const banner = screen.getByRole("note", { name: /catalog freshness/i });
    expect(within(banner).getByText(/out of date for claude-code/i)).toBeTruthy();
    expect(banner).toHaveClass("freshness-attention");
  });

  it("uses a quieter status role for merely being behind upstream", () => {
    render(
      <App
        freshness={{
          ...IN_SYNC,
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
        }}
      />,
    );
    expect(screen.queryByRole("alert", { name: /catalog freshness/i })).toBeNull();
    const banner = screen.getByRole("note", { name: /catalog freshness/i });
    expect(within(banner).getByText(/1 tool behind upstream/i)).toBeTruthy();
  });

  // The app's authority rests on being offline and local; the banner must say where
  // its information came from so it is never mistaken for a catalog fact.
  it("states that the notice came from a separate offline check", () => {
    render(<App freshness={null} />);
    const banner = screen.getByLabelText(/catalog freshness/i);
    expect(within(banner).getByText(/not from the app/i, { selector: "p" })).toBeTruthy();
  });

  it("never blocks the catalog from being used", () => {
    render(<App freshness={null} />);
    // Search still works with a freshness warning on screen.
    expect(screen.getByRole("searchbox", { name: /operator intent/i })).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });

  it("ignores a malformed freshness file rather than crashing", () => {
    render(<App freshness={{ nonsense: true }} />);
    const banner = screen.getByLabelText(/catalog freshness/i);
    expect(within(banner).getByText(/never checked for updates/i, { selector: "b" })).toBeTruthy();
  });
});
