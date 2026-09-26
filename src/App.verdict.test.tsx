import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { ShortcutEnvironmentReport } from "./shortcutEnvironment";

/**
 * Task 4: keyboard-aware verdicts for chord queries.
 *
 * The catalog says what upstream ships; the probe says what THIS machine has
 * bound. The verdict strip reconciles the two for the operator — and stays
 * honest at every level of ignorance:
 *   - probe ok, chord bound here  -> name the local binding ("active here")
 *   - probe ok, chord not bound   -> "not active in the detected binding set"
 *                                    (never "impossible": submaps/other layers exist)
 *   - probe unavailable           -> "cannot verify" + the probe's fixed reason
 *   - non-chord query             -> no verdict at all
 * Advisory only: role=note, outside any live region, gates nothing.
 */

const OK_ENVIRONMENT: ShortcutEnvironmentReport = {
  status: "ok",
  unavailableReason: null,
  bindings: [
    { chord: "shift+super+a", description: "ChatGPT", dispatcher: "exec" },
    { chord: "super+return", description: "Terminal", dispatcher: "exec" },
  ],
  truncated: false,
  keyboard: { layouts: ["us"], activeKeymap: "English (US)" },
};

const UNAVAILABLE_ENVIRONMENT: ShortcutEnvironmentReport = {
  status: "unavailable",
  unavailableReason: "Shortcut probing needs a Hyprland session (this session is not Hyprland)",
  bindings: [],
  truncated: false,
  keyboard: { layouts: [], activeKeymap: null },
};

describe("chord verdict strip", () => {
  it("names the local binding when the chord is active on this machine", async () => {
    const user = userEvent.setup();
    render(<App shortcutEnvironment={OK_ENVIRONMENT} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "SUPER + SHIFT + A");

    const verdict = await screen.findByRole("note", { name: /local binding check/i });
    expect(verdict).toHaveTextContent(/active on this machine/i);
    expect(verdict).toHaveTextContent(/ChatGPT/);
    // Keyboard hint is observed fact, stated as such.
    expect(verdict).toHaveTextContent(/English \(US\)/);
  });

  it("says a probed-but-unbound chord is not in the detected set — never impossible", async () => {
    const user = userEvent.setup();
    render(<App shortcutEnvironment={OK_ENVIRONMENT} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "SUPER + A");

    const verdict = await screen.findByRole("note", { name: /local binding check/i });
    expect(verdict).toHaveTextContent(/not active in the detected binding set/i);
    expect(verdict.textContent).not.toMatch(/impossible|never|cannot be bound/i);
    // The verdict must not silence the history ledger next to it.
    expect(await screen.findByRole("note", { name: /shortcut history/i })).toBeInTheDocument();
  });

  it("admits it cannot verify when the probe is unavailable, with the fixed reason", async () => {
    const user = userEvent.setup();
    render(<App shortcutEnvironment={UNAVAILABLE_ENVIRONMENT} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "SUPER + SHIFT + A");

    const verdict = await screen.findByRole("note", { name: /local binding check/i });
    expect(verdict).toHaveTextContent(/can't verify local bindings|cannot verify local bindings/i);
    expect(verdict).toHaveTextContent(/needs a Hyprland session/i);
    // An unavailable probe must never be phrased as absence.
    expect(verdict.textContent).not.toMatch(/not active/i);
  });

  it("reaches the same verdict through modifier aliases (win, meta, glyphs)", async () => {
    const user = userEvent.setup();
    render(<App shortcutEnvironment={OK_ENVIRONMENT} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "win shift a");

    const verdict = await screen.findByRole("note", { name: /local binding check/i });
    expect(verdict).toHaveTextContent(/active on this machine/i);
    expect(verdict).toHaveTextContent(/ChatGPT/);
  });

  it("renders no verdict for a plain-language query", async () => {
    const user = userEvent.setup();
    render(<App shortcutEnvironment={OK_ENVIRONMENT} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "terminal");

    // Wait past the query-settle delay: the verdict memo reads the SETTLED query,
    // so asserting immediately would pass even against a leaky implementation.
    await screen.findAllByRole("option");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByRole("note", { name: /local binding check/i })).not.toBeInTheDocument();
  });

  it("renders no verdict for a plain-language query even with zero results", async () => {
    // The empty view shows history/verdict machinery; a prose query that happens
    // to find nothing must not be treated as a chord.
    const user = userEvent.setup();
    render(<App shortcutEnvironment={OK_ENVIRONMENT} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "zxqvv nonsense");

    await screen.findByRole("status");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByRole("note", { name: /local binding check/i })).not.toBeInTheDocument();
  });

  it("keeps the verdict outside live regions and leaves results interactive", async () => {
    const user = userEvent.setup();
    render(<App shortcutEnvironment={OK_ENVIRONMENT} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "SUPER + SHIFT + A");

    const verdict = await screen.findByRole("note", { name: /local binding check/i });
    // Advisory placement: not inside any status/alert live region.
    for (const status of screen.queryAllByRole("status")) {
      expect(within(status).queryByRole("note", { name: /local binding check/i })).not.toBeInTheDocument();
    }
    expect(verdict.getAttribute("role")).toBe("note");
    // The chord's live catalog entry still renders and stays selectable.
    expect(await screen.findByRole("option", { selected: true, name: /ChatGPT/i })).toBeInTheDocument();
  });

  it("keeps the verdict outside the empty-view status region too", async () => {
    // The empty view has its own role="status" panel; the verdict must sit beside
    // it, not inside — nested, the standing advisory would be announced as
    // transient status on every render.
    const user = userEvent.setup();
    render(<App shortcutEnvironment={OK_ENVIRONMENT} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "SUPER + A");

    const verdict = await screen.findByRole("note", { name: /local binding check/i });
    expect(verdict).toBeInTheDocument();
    const empty = await screen.findByRole("status");
    expect(within(empty).queryByRole("note", { name: /local binding check/i })).not.toBeInTheDocument();
  });

  it("without an injected environment (web/test default) stays honest: cannot verify", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "SUPER + SHIFT + A");

    const verdict = await screen.findByRole("note", { name: /local binding check/i });
    expect(verdict).toHaveTextContent(/can't verify|cannot verify/i);
    expect(verdict.textContent).not.toMatch(/not active/i);
  });
});
