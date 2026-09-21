import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

describe("freshness banner", () => {
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
  it("raises an alert when the catalog no longer matches installed tools", () => {
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
    const banner = screen.getByRole("alert", { name: /catalog freshness/i });
    expect(within(banner).getByText(/out of date for claude-code/i)).toBeTruthy();
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
