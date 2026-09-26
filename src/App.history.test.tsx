import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

/**
 * The empty-result view must distinguish "not in the current catalog" from
 * "historically moved": SUPER + A launched ChatGPT on Omarchy up to 3.0.2 and
 * was retired in 3.1.0. An operator typing the retired chord deserves the
 * forwarding address — clearly labelled as history, never as a live binding.
 */
describe("shortcut history advisory on empty results", () => {
  it("explains where a retired chord went, labelled historical with upstream sources", async () => {
    const user = userEvent.setup();
    render(<App />);
    const search = screen.getByRole("searchbox", { name: /operator intent/i });
    await user.type(search, "SUPER + A");

    // Exact-only chord lookup finds nothing bound to SUPER + A today...
    const empty = await screen.findByRole("status");
    expect(empty).toHaveTextContent(/no matching command/i);

    // ...but the ledger explains the move, as an advisory note (never status/alert:
    // those are the app's transient feedback channels).
    const note = await screen.findByRole("note", { name: /shortcut history/i });
    // And the note must sit OUTSIDE the role="status" live region: nested inside it,
    // the standing advisory would be announced as transient status on every render.
    expect(within(empty).queryByRole("note", { name: /shortcut history/i })).not.toBeInTheDocument();
    expect(note).toHaveTextContent(/ChatGPT/);
    expect(note).toHaveTextContent(/SUPER \+ SHIFT \+ A/);
    expect(note).toHaveTextContent(/3\.0\.2/);
    expect(note).toHaveTextContent(/3\.1\.0/);
    expect(note).toHaveTextContent(/historical|no longer|retired|moved/i);
    // It must never claim the old chord still works.
    expect(note.textContent).not.toMatch(/currently bound to SUPER \+ A(?!.*SHIFT)/i);

    // Exact upstream provenance rendered as real links.
    const links = within(note).getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute("href", expect.stringMatching(/^https:\/\/github\.com\//));
      // External links from a desktop webview must not navigate the overlay itself.
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.getAttribute("rel") ?? "").toMatch(/noreferrer/);
    }
    const hrefs = links.map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("https://github.com/omacom/omarchy/commit/fcae2e9809a83cafa5e267934ca9cea28a3686b8");
  });

  it("also explains history when the operator searches the current chord's old home via glyphs", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "⌘ A");

    await screen.findByRole("status");
    const note = await screen.findByRole("note", { name: /shortcut history/i });
    expect(note).toHaveTextContent(/ChatGPT/);
  });

  it("stays silent for an unbound chord with no recorded history", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "SUPER + Q");

    const empty = await screen.findByRole("status");
    expect(empty).toHaveTextContent(/no matching command/i);
    expect(screen.queryByRole("note", { name: /shortcut history/i })).not.toBeInTheDocument();
  });

  it("stays silent for a plain-language query with no results", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "zxqvv nonsense");

    await screen.findByRole("status");
    expect(screen.queryByRole("note", { name: /shortcut history/i })).not.toBeInTheDocument();
  });

  it("does not render the history note when the current chord finds its live entry", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "SUPER + SHIFT + A");

    // Live catalog entry renders — the reverse lookup answered; history would be noise.
    // findByRole with the name filter retries past the query-settle delay until the
    // ChatGPT row IS the selection, instead of grabbing an intermediate selection.
    expect(await screen.findByRole("option", { selected: true, name: /ChatGPT/i })).toBeInTheDocument();
    expect(screen.queryByRole("note", { name: /shortcut history/i })).not.toBeInTheDocument();
  });
});
