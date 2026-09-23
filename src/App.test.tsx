import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import catalogJson from "../data/catalog.json";
import App from "./App";
import { parseCatalog } from "./catalog";
import { buildIntentCandidateIds, type IntentReasoner, type SparkIntentPlan } from "./intent";
import { createSearchIndex, searchCatalog } from "./search";

const CHAT_ID = "bba8772153ddeadc";
const STATUS_ID = "16fe16d89f85e6a8";

function sparkPlan(overrides: Partial<SparkIntentPlan> = {}): SparkIntentPlan {
  return {
    model: "test-model:7b",
    summary: "Inspect the agent, then open an interactive session.",
    assumptions: ["Codex CLI is authenticated."],
    gaps: ["The target workspace is not specified."],
    recommendations: [
      { entryId: STATUS_ID, sequence: 1, purpose: "Check agent health.", inputHint: "No input required.", confidence: "high" },
      { entryId: CHAT_ID, sequence: 2, purpose: "Start the session.", inputHint: "Continue with the workspace goal.", confidence: "medium" },
    ],
    ...overrides,
  };
}

function nativeReasoner(overrides: Partial<IntentReasoner> = {}): IntentReasoner {
  return {
    status: vi.fn().mockResolvedValue({ available: true, loggedIn: true, model: "test-model:7b", provider: "ollama", configPath: "/tmp/reasoning.json", message: "Local model server reachable. Reasoning uses test-model:7b." }),
    reason: vi.fn().mockResolvedValue(sparkPlan()),
    ...overrides,
  };
}

describe("Operator Key overlay", () => {
  it("turns an empty-state task starter into search only, then hides the rail", async () => {
    const user = userEvent.setup();
    const actions = { copy: vi.fn(), insert: vi.fn() };
    render(<App actions={actions} />);
    const rail = screen.getByLabelText("Task starters");
    const starter = screen.getAllByRole("button", { name: /sessions and navigation/i })[0];
    await user.click(starter);
    expect(screen.getByRole("searchbox", { name: /operator intent/i })).toHaveValue("sessions and navigation");
    expect(await screen.findByRole("option", { selected: true })).toHaveTextContent(/move/i);
    expect(screen.getByRole("button", { name: "sessions and navigation" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText("Task starters")).not.toBeInTheDocument();
    expect(actions.copy).not.toHaveBeenCalled();
    expect(actions.insert).not.toHaveBeenCalled();
    expect(rail).not.toBeInTheDocument();
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("returns focus to search when a task starter is accepted with %s", async (_key, key) => {
    const user = userEvent.setup();
    const actions = { copy: vi.fn(), insert: vi.fn() };
    const reasoner = nativeReasoner();
    render(<App actions={actions} intentReasoner={reasoner} />);
    const starter = screen.getAllByRole("button", { name: /sessions and navigation/i })[0];

    starter.focus();
    await user.keyboard(key);

    const search = screen.getByRole("searchbox", { name: /operator intent/i });
    expect(search).toHaveFocus();
    expect(search).toHaveValue("sessions and navigation");
    expect(await screen.findByRole("option", { selected: true })).toHaveTextContent(/move/i);
    expect(screen.getByRole("button", { name: "sessions and navigation" })).toHaveAttribute("aria-pressed", "true");
    expect(actions.copy).not.toHaveBeenCalled();
    expect(actions.insert).not.toHaveBeenCalled();
    expect(reasoner.reason).not.toHaveBeenCalled();
  });

  it("offers disabled native reasoning configuration and focuses its Settings section", async () => {
    const user = userEvent.setup();
    const reasoner = nativeReasoner({
      status: vi.fn().mockResolvedValue({ available: false, loggedIn: false, model: "", provider: "disabled", configPath: "/private/home/reasoning.json", message: "Reasoning is off." }),
    });
    render(<App runtime="native" intentReasoner={reasoner} />);
    const configure = await screen.findByRole("button", { name: /configure reasoning/i });
    await user.click(configure);
    expect(screen.getByRole("region", { name: /optional local reasoning/i })).toHaveFocus();
  });

  it("keeps browser reasoning guidance truthful without native configuration IPC", async () => {
    const reasoner = nativeReasoner();
    render(<App runtime="web" intentReasoner={reasoner} />);
    expect(await screen.findByText(/reasoning requires the native operator key app/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /configure reasoning/i })).not.toBeInTheDocument();
    expect(reasoner.status).toHaveBeenCalledOnce();
    expect(reasoner.reason).not.toHaveBeenCalled();
    expect(screen.queryByText(/sends .* to openai through local codex/i)).not.toBeInTheDocument();
  });

  it.each([
    [{ canCopy: true, canInsert: true }, /native copy: ready/i, /terminal insertion: ready/i],
    [{ canCopy: false, canInsert: false }, /native copy: needs setup/i, /terminal insertion: needs setup/i],
    [{ canCopy: false, canInsert: true }, /native copy: needs setup/i, /terminal insertion: needs setup/i],
  ])("reports native desktop readiness from loaded capabilities", async (capabilities, copyText, insertText) => {
    const user = userEvent.setup();
    render(<App runtime="native" desktopCapabilities={capabilities} intentReasoner={nativeReasoner()} />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const readiness = screen.getByRole("region", { name: /desktop readiness/i });
    expect(readiness).toHaveTextContent(/local catalog search: available/i);
    expect(readiness).toHaveTextContent(copyText);
    expect(readiness).toHaveTextContent(insertText);
    // A definite state, never an ambiguous "not confirmed" the operator cannot act on.
    expect(readiness).not.toHaveTextContent(/not confirmed/i);
    expect(readiness).toHaveTextContent(/wayland.*wl-copy/i);
    expect(readiness).toHaveTextContent(/hyprland.*wtype/i);
    expect(readiness).toHaveTextContent(/does not press enter|no command is executed/i);
  });

  it("names the exact missing prerequisites when a desktop capability is unavailable", async () => {
    const user = userEvent.setup();
    // A GNOME/KDE Wayland session: copy works, insertion structurally cannot.
    render(<App runtime="native" desktopCapabilities={{ canCopy: true, canInsert: false }} intentReasoner={nativeReasoner()} desktopCompatibility={{
      mode: "degraded",
      capabilities: { canCopy: true, canInsert: false },
      searchAvailable: true,
      requirements: [
        { feature: "search", met: true, unmetPrerequisites: [] },
        { feature: "copy", met: true, unmetPrerequisites: [] },
        { feature: "insert", met: false, unmetPrerequisites: ["Hyprland, for the window IPC that confirms the target terminal", "wtype, on PATH"] },
      ],
    }} />);
    await user.click(screen.getByRole("button", { name: "Settings" }));

    const readiness = screen.getByRole("region", { name: /desktop readiness/i });
    // "Not confirmed" alone is not actionable: the operator must see what to install.
    expect(readiness).toHaveTextContent(/hyprland, for the window ipc that confirms the target terminal/i);
    expect(readiness).toHaveTextContent(/wtype, on path/i);
    // A degraded desktop is not a broken one; search and copy must not read as blocked.
    expect(readiness).toHaveTextContent(/partly supported|degraded/i);
  });

  it("does not list prerequisites for a fully supported desktop", async () => {
    const user = userEvent.setup();
    render(<App runtime="native" desktopCapabilities={{ canCopy: true, canInsert: true }} intentReasoner={nativeReasoner()} desktopCompatibility={{
      mode: "supported",
      capabilities: { canCopy: true, canInsert: true },
      searchAvailable: true,
      requirements: [
        { feature: "search", met: true, unmetPrerequisites: [] },
        { feature: "copy", met: true, unmetPrerequisites: [] },
        { feature: "insert", met: true, unmetPrerequisites: [] },
      ],
    }} />);
    await user.click(screen.getByRole("button", { name: "Settings" }));

    const readiness = screen.getByRole("region", { name: /desktop readiness/i });
    expect(readiness).toHaveTextContent(/fully supported|supported/i);
    expect(readiness).not.toHaveTextContent(/to enable this, install/i);
    // Availability is still not a claim that an operation already succeeded.
    expect(readiness).toHaveTextContent(/does not press enter|no command is executed/i);
  });

  it("keeps search described as available on a fully unsupported desktop", async () => {
    const user = userEvent.setup();
    render(<App runtime="native" desktopCapabilities={{ canCopy: false, canInsert: false }} intentReasoner={nativeReasoner()} desktopCompatibility={{
      mode: "unsupported",
      capabilities: { canCopy: false, canInsert: false },
      searchAvailable: true,
      requirements: [
        { feature: "search", met: true, unmetPrerequisites: [] },
        { feature: "copy", met: false, unmetPrerequisites: ["A Wayland session (this session is not Wayland)"] },
        { feature: "insert", met: false, unmetPrerequisites: ["A Wayland session (this session is not Wayland)"] },
      ],
    }} />);
    await user.click(screen.getByRole("button", { name: "Settings" }));

    const readiness = screen.getByRole("region", { name: /desktop readiness/i });
    expect(readiness).toHaveTextContent(/local catalog search: available/i);
    expect(readiness).toHaveTextContent(/a wayland session \(this session is not wayland\)/i);
    // Never leak the operator's environment into a report they may paste into an issue.
    expect(readiness).not.toHaveTextContent(/\/home\//);
  });

  it("reports permission-dependent browser copy and unsupported insertion", async () => {
    const user = userEvent.setup();
    render(<App runtime="web" />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const readiness = screen.getByRole("region", { name: /desktop readiness/i });
    expect(readiness).toHaveTextContent(/browser copy: permission-dependent/i);
    expect(readiness).toHaveTextContent(/terminal insertion: unsupported/i);
  });
  it("renders the keyboard-first search shell and catalog status", () => {
    render(<App />);
    expect(screen.getByRole("searchbox", { name: /operator intent/i })).toHaveFocus();
    expect(screen.getByRole("radiogroup", { name: /product lanes/i })).toBeInTheDocument();
    // Derived from the shipped catalog so a rebuild does not fail a UI test that is
    // really about the banner rendering at all.
    const expectedTotal = (catalogJson as { total: number }).total.toLocaleString("en-US");
    expect(screen.getByText(new RegExp(`${expectedTotal} commands ready`, "i"))).toBeInTheDocument();
    expect(screen.getByText(/active context/i)).toBeInTheDocument();
  });

  it("searches as typed and moves result selection with arrow keys", async () => {
    const user = userEvent.setup();
    render(<App />);
    const search = screen.getByRole("searchbox", { name: /operator intent/i });
    await user.type(search, "review code");
    expect(await screen.findByRole("heading", { name: "/code-review" })).toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { selected: true })).toHaveAttribute("aria-posinset", "2");
  });

  it("debounces result reconciliation while preserving immediate query input", () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      const search = screen.getByRole("searchbox", { name: /operator intent/i });
      const initialHeading = screen.getByRole("heading", { level: 2 }).textContent;

      fireEvent.change(search, { target: { value: "h" } });
      fireEvent.change(search, { target: { value: "hermes status" } });

      expect(search).toHaveValue("hermes status");
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(initialHeading ?? "");
      act(() => vi.advanceTimersByTime(119));
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(initialHeading ?? "");
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("hermes status");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps keyboard selection inside the result scroller without moving the page", async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    const originalBounds = Element.prototype.getBoundingClientRect;
    let bounds: ReturnType<typeof vi.spyOn> | undefined;

    try {
      Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
      bounds = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        if (this.id === "result-list") return DOMRect.fromRect({ x: 0, y: 0, width: 320, height: 100 });
        if (this.getAttribute("role") === "option") {
          const position = Number(this.getAttribute("aria-posinset") ?? "1");
          const y = (position - 1) * 52 - (this.parentElement?.scrollTop ?? 0);
          return DOMRect.fromRect({ x: 0, y, width: 320, height: 52 });
        }
        return originalBounds.call(this);
      });

      const user = userEvent.setup();
      render(<App />);
      const resultList = screen.getByRole("listbox", { name: /command results/i });
      const search = screen.getByRole("searchbox", { name: /operator intent/i });
      await user.type(search, "review code");
      await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
      await waitFor(() => expect(resultList.scrollTop).toBeGreaterThan(0));
      const downwardScroll = resultList.scrollTop;

      await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
      await waitFor(() => expect(resultList.scrollTop).toBeLessThan(downwardScroll));
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(window.scrollY).toBe(0);
    } finally {
      bounds?.mockRestore();
      if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
      else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("dismisses once with Escape from controls outside the search input", async () => {
    const user = userEvent.setup();
    const hideOverlay = vi.fn();
    render(<App runtime="native" hideOverlay={hideOverlay} />);

    screen.getByRole("button", { name: /large text/i }).focus();
    await user.keyboard("{Escape}");
    expect(hideOverlay).toHaveBeenCalledTimes(1);

    screen.getByRole("searchbox", { name: /operator intent/i }).focus();
    await user.keyboard("{Escape}");
    expect(hideOverlay).toHaveBeenCalledTimes(2);
  });

  it("offers an accessible visible close control", async () => {
    const user = userEvent.setup();
    const hideOverlay = vi.fn();
    render(<App runtime="native" hideOverlay={hideOverlay} />);
    await user.click(screen.getByRole("button", { name: /close operator key/i }));
    expect(hideOverlay).toHaveBeenCalledOnce();
  });

  it("clears web search with Escape and Reset without invoking the native overlay", async () => {
    const user = userEvent.setup();
    const hideOverlay = vi.fn();
    render(<App runtime="web" hideOverlay={hideOverlay} />);
    const search = screen.getByRole("searchbox", { name: /operator intent/i });
    await user.type(search, "review code");
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    await user.click(screen.getByRole("button", { name: /reset search/i }));
    expect(hideOverlay).not.toHaveBeenCalled();
  });

  it("identifies the browser deck and disables insertion with a companion explanation", () => {
    render(<App runtime="web" />);
    expect(screen.getAllByText(/web deck · copy only/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/you remember the task/i)).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /primary navigation/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /insert into confirmed terminal/i })).toBeDisabled();
    expect(screen.getByText(/install\/open the native operator key companion/i)).toBeInTheDocument();
  });

  it("provides filters and an explicit empty state", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.selectOptions(screen.getByLabelText(/safety filter/i), "red");
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "move window");
    expect(await screen.findByRole("status")).toHaveTextContent(/no matching command/i);
  });

  it("copies the selected catalog command with Enter", async () => {
    const user = userEvent.setup();
    const actions = { copy: vi.fn().mockResolvedValue(undefined), insert: vi.fn().mockResolvedValue(undefined) };
    render(<App actions={actions} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "hermes chat");
    await user.keyboard("{Enter}");
    expect(actions.copy).toHaveBeenCalledOnce();
    expect(actions.copy.mock.calls[0][0]).toMatchObject({ command: "hermes chat" });
    expect(actions.insert).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/copied/i);
  });

  it("inserts a terminal-compatible selection only with Shift+Enter", async () => {
    const user = userEvent.setup();
    const actions = { copy: vi.fn().mockResolvedValue(undefined), insert: vi.fn().mockResolvedValue(undefined) };
    render(<App runtime="native" actions={actions} desktopCapabilities={{ canCopy: true, canInsert: true }} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "hermes chat");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(actions.insert).toHaveBeenCalledOnce();
    expect(actions.insert.mock.calls[0][0]).toMatchObject({ command: "hermes chat" });
    expect(actions.copy).not.toHaveBeenCalled();
  });

  it("keeps Ctrl+Enter execution disabled without invoking either action", async () => {
    const user = userEvent.setup();
    const actions = { copy: vi.fn().mockResolvedValue(undefined), insert: vi.fn().mockResolvedValue(undefined) };
    render(<App actions={actions} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "hermes chat");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(actions.copy).not.toHaveBeenCalled();
    expect(actions.insert).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/execution.*disabled/i);
  });

  it("shows red commands as explicitly warned and copy-only", async () => {
    const user = userEvent.setup();
    const actions = { copy: vi.fn().mockResolvedValue(undefined), insert: vi.fn().mockResolvedValue(undefined) };
    render(<App runtime="native" actions={actions} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "hermes logout");
    expect(await screen.findByRole("alert")).toHaveTextContent(/danger|red/i);
    expect(screen.getByRole("button", { name: /insert into confirmed terminal/i })).toBeDisabled();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(actions.insert).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/native clipboard needs wayland/i);
  });

  it("reports native copy failures without implying success", async () => {
    const user = userEvent.setup();
    const actions = { copy: vi.fn().mockRejectedValue(new Error("clipboard unavailable")), insert: vi.fn() };
    render(<App actions={actions} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "hermes chat");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/clipboard unavailable/i);
    expect(screen.queryByText(/^copied/i)).not.toBeInTheDocument();
  });

  it("locks query, filters, and selection while an action is pending", async () => {
    const user = userEvent.setup();
    let finishCopy: (() => void) | undefined;
    const actions = {
      copy: vi.fn(() => new Promise<void>((resolve) => { finishCopy = resolve; })),
      insert: vi.fn(),
    };
    render(<App actions={actions} />);
    const search = screen.getByRole("searchbox", { name: /operator intent/i });
    await user.type(search, "hermes chat");
    await user.keyboard("{Enter}");

    expect(search).toBeDisabled();
    expect(screen.getByLabelText(/interface filter/i)).toBeDisabled();
    expect(screen.getByLabelText(/safety filter/i)).toBeDisabled();
    expect(screen.getAllByRole("radio").every((control) => control.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("listbox", { name: /command results/i })).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByRole("option").every((option) => option.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(screen.getAllByRole("button", { name: /task/i }).every((control) => control.hasAttribute("disabled"))).toBe(true);

    finishCopy?.();
    expect(await screen.findByRole("status")).toHaveTextContent(/copied “hermes chat”/i);
    await waitFor(() => expect(search).not.toBeDisabled());
  });


  it("explains rather than fails when the desktop cannot insert", async () => {
    // A non-Wayland or non-Hyprland desktop previously produced a raw
    // "could not start hyprctl" error only after the operator pressed the button.
    const user = userEvent.setup();
    const actions = { copy: vi.fn().mockResolvedValue(undefined), insert: vi.fn().mockResolvedValue(undefined) };
    render(<App runtime="native" actions={actions} desktopCapabilities={{ canCopy: true, canInsert: false }} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "hermes chat");

    const insert = screen.getByRole("button", { name: /insert into confirmed terminal/i });
    await waitFor(() => expect(insert).toBeDisabled());
    expect(document.getElementById("insert-disabled-reason")).toHaveTextContent(/wayland/i);

    // The keyboard path must be gated too, not just the button.
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(actions.insert).not.toHaveBeenCalled();
  });

  it("associates the disabled insertion explanation with the control", async () => {
    const user = userEvent.setup();
    render(<App runtime="native" desktopCapabilities={{ canCopy: true, canInsert: true }} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "hermes logout");

    const insert = screen.getByRole("button", { name: /insert into confirmed terminal/i });
    await waitFor(() => expect(insert).toHaveAttribute("aria-describedby", "insert-disabled-reason"));
    expect(document.getElementById("insert-disabled-reason")).toHaveTextContent(/copy-only/i);
  });

  it("moves across the product single-select group with the keyboard and filters results", async () => {
    const user = userEvent.setup();
    render(<App />);
    const allProduct = screen.getByRole("radio", { name: /^all/i });
    allProduct.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: /omarchy/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByRole("option").every((option) => option.dataset.product === "omarchy")).toBe(true);
  });

  it("labels safety visibly in every result row instead of relying on color", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "Ctrl+B");
    for (const option of screen.getAllByRole("option")) {
      expect(option).toHaveTextContent(/safe|caution|danger/i);
    }
  });

  it("shows context, safety, version, provenance, alternatives, and chord conflicts", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "Ctrl+B");
    expect(await screen.findByText(/binding conflict/i)).toBeInTheDocument();
    expect(screen.getByText(/safety level/i)).toBeInTheDocument();
    expect(screen.getByText(/version/i)).toBeInTheDocument();
    expect(screen.getByText("Provenance", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /alternatives/i })).toBeInTheDocument();
  });

  it("offers a persistent large-text preference", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /large text/i }));
    expect(screen.getByTestId("operator-shell")).toHaveClass("large-text");
    expect(screen.getByRole("radiogroup", { name: /product lanes/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/interface filter/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/safety filter/i)).toBeInTheDocument();
  });

  it("renders non-crashing loading and catalog-error states", () => {
    const { rerender } = render(<App loading />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading command catalog/i);
    rerender(<App catalogData={{ entries: [] }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/catalog is missing schema_version/i);
  });

  it("checks native reasoning status on mount without reasoning automatically", async () => {
    const reasoner = nativeReasoner();
    render(<App runtime="native" intentReasoner={reasoner} />);
    expect(screen.getByText(/checking reasoning status/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/reasoning uses test-model/i)).toBeInTheDocument());
    expect(reasoner.status).toHaveBeenCalledOnce();
    expect(reasoner.reason).not.toHaveBeenCalled();
    const reasoningButton = screen.getByRole("button", { name: /^reason\b/i });
    expect(reasoningButton).toHaveAttribute("aria-describedby", "reasoning-availability");
    expect(document.getElementById("reasoning-availability")).toHaveAttribute("aria-live", "polite");
    expect(document.getElementById("reasoning-availability")).toHaveAttribute("aria-atomic", "true");
    expect(screen.getByText(/bounded command fields shown in the local catalog.*never source paths, provenance, files, secrets, terminal contents, or history/i)).toBeInTheDocument();
  });

  it("disables reasoning in the browser and explains the native app requirement", async () => {
    const reasoner = nativeReasoner();
    render(<App runtime="web" intentReasoner={reasoner} />);
    const button = screen.getByRole("button", { name: /^reason\b/i });
    expect(button).toBeDisabled();
    expect(screen.getAllByText(/native operator key companion/i).length).toBeGreaterThan(0);
    expect(reasoner.reason).not.toHaveBeenCalled();
  });

  it("shows signed-out native status and keeps reasoning disabled", async () => {
    const reasoner = nativeReasoner({
      status: vi.fn().mockResolvedValue({ available: true, loggedIn: false, model: "test-model:7b", provider: "codex", configPath: "/tmp/reasoning.json", message: "Codex is signed out. Run `codex login` to sign in before using reasoning." }),
    });
    const user = userEvent.setup();
    render(<App runtime="native" intentReasoner={reasoner} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "Open an interactive Hermes session after checking status.");
    expect(await screen.findByText(/codex is signed out/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^reason\b/i })).toBeDisabled();
  });

  it("reasons only on Alt+Enter and sends the exact bounded candidate IDs", async () => {
    const user = userEvent.setup();
    const reasoner = nativeReasoner();
    render(<App runtime="native" intentReasoner={reasoner} />);
    const input = screen.getByRole("searchbox", { name: /operator intent/i });
    const intent = "Open an interactive Hermes session after checking status.";
    await user.type(input, intent);
    await screen.findByText(/reasoning uses test-model/i);
    await user.keyboard("{Alt>}{Enter}{/Alt}");

    const parsed = parseCatalog(catalogJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const localResults = searchCatalog(createSearchIndex(parsed.catalog.entries), intent, {}, 50);
    expect(reasoner.reason).toHaveBeenCalledWith(
      intent,
      buildIntentCandidateIds(parsed.catalog.entries, intent, {}, localResults),
    );
  });

  it("locks every interaction including Escape while reasoning is pending without copying or inserting", async () => {
    const user = userEvent.setup();
    let finishReasoning: ((plan: SparkIntentPlan) => void) | undefined;
    const reasoner = nativeReasoner({ reason: vi.fn(() => new Promise<SparkIntentPlan>((resolve) => { finishReasoning = resolve; })) });
    const actions = { copy: vi.fn(), insert: vi.fn() };
    const hideOverlay = vi.fn();
    render(<App runtime="native" intentReasoner={reasoner} actions={actions} hideOverlay={hideOverlay} />);
    const input = screen.getByRole("searchbox", { name: /operator intent/i });
    await user.type(input, "hermes status");
    await screen.findByText(/reasoning uses test-model/i);
    await user.click(screen.getByRole("button", { name: /^reason\b/i }));

    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: /^reason\b/i })).toBeDisabled();
    expect(screen.getByLabelText(/interface filter/i)).toBeDisabled();
    expect(screen.getByLabelText(/safety filter/i)).toBeDisabled();
    expect(screen.getByRole("listbox", { name: /command results/i })).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByRole("option").every((option) => option.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(screen.getByRole("button", { name: /copy command/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /large text/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /close operator key/i })).toBeDisabled();
    expect(actions.copy).not.toHaveBeenCalled();
    expect(actions.insert).not.toHaveBeenCalled();
    expect(document.getElementById("reasoning-availability")).toHaveTextContent(/reasoning in progress/i);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(hideOverlay).not.toHaveBeenCalled();
    expect(input).toHaveValue("hermes status");

    finishReasoning?.(sparkPlan());
    await screen.findByRole("region", { name: /intent structure/i });
    expect(screen.getByText(/reasoning complete with 2 ordered commands/i)).toHaveAttribute("role", "status");
  });

  it("renders trusted catalog commands in recommendation order with assumptions and gaps", async () => {
    const user = userEvent.setup();
    const reasoner = nativeReasoner();
    render(<App runtime="native" intentReasoner={reasoner} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "Check status then start chat.");
    await screen.findByText(/reasoning uses test-model/i);
    await user.click(screen.getByRole("button", { name: /^reason\b/i }));

    const structure = await screen.findByRole("region", { name: /intent structure/i });
    expect(structure).toHaveTextContent("test-model:7b");
    expect(structure).toHaveTextContent("Inspect the agent, then open an interactive session.");
    expect(structure).toHaveTextContent("Codex CLI is authenticated.");
    expect(structure).toHaveTextContent("The target workspace is not specified.");
    expect(structure).toHaveTextContent("Check agent health.");
    expect(structure).toHaveTextContent("No input required.");
    expect(structure).toHaveTextContent(/high/i);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("hermes status");
    expect(options[1]).toHaveTextContent("hermes chat");
    expect(screen.getByRole("heading", { name: "hermes status", level: 2 })).toBeInTheDocument();
  });

  it("fails closed when Spark returns an unknown catalog ID", async () => {
    const user = userEvent.setup();
    const reasoner = nativeReasoner({
      reason: vi.fn().mockResolvedValue(sparkPlan({ recommendations: [{ entryId: "model-invented-command", sequence: 1, purpose: "Unsafe invention", inputHint: "", confidence: "high" }] })),
    });
    render(<App runtime="native" intentReasoner={reasoner} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "Do a made-up thing.");
    await screen.findByText(/reasoning uses test-model/i);
    await user.click(screen.getByRole("button", { name: /^reason\b/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/unknown.*model-invented-command/i);
    expect(screen.queryByText("Unsafe invention")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /intent structure/i })).not.toBeInTheDocument();
  });

  it("surfaces provider errors without implying a plan exists", async () => {
    const user = userEvent.setup();
    const reasoner = nativeReasoner({ reason: vi.fn().mockRejectedValue(new Error("Codex request timed out")) });
    render(<App runtime="native" intentReasoner={reasoner} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "Check status.");
    await screen.findByText(/reasoning uses test-model/i);
    await user.click(screen.getByRole("button", { name: /^reason\b/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/codex request timed out/i);
    expect(screen.queryByRole("region", { name: /intent structure/i })).not.toBeInTheDocument();
  });

  it.each([
    ["product", () => screen.getByRole("radio", { name: /hermes/i })],
    ["task", () => screen.getByRole("button", { name: /^parallel agents$/i })],
    ["interface", () => screen.getByLabelText(/interface filter/i)],
    ["safety", () => screen.getByLabelText(/safety filter/i)],
  ])("clears a stale plan when the %s filter changes", async (kind, getControl) => {
    const user = userEvent.setup();
    render(<App runtime="native" intentReasoner={nativeReasoner()} />);
    const input = screen.getByRole("searchbox", { name: /operator intent/i });
    await user.type(input, "Check status then chat.");
    await screen.findByText(/reasoning uses test-model/i);
    await user.click(screen.getByRole("button", { name: /^reason\b/i }));
    expect(await screen.findByRole("region", { name: /intent structure/i })).toBeInTheDocument();

    const control = getControl();
    if (kind === "interface") await user.selectOptions(control, "shell-command");
    else if (kind === "safety") await user.selectOptions(control, "green");
    else await user.click(control);
    expect(screen.queryByRole("region", { name: /intent structure/i })).not.toBeInTheDocument();
  });

  it("clears stale plan and errors on query changes", async () => {
    const user = userEvent.setup();
    const reasoner = nativeReasoner();
    render(<App runtime="native" intentReasoner={reasoner} />);
    const input = screen.getByRole("searchbox", { name: /operator intent/i });
    await user.type(input, "Check status then chat.");
    await screen.findByText(/reasoning uses test-model/i);
    await user.click(screen.getByRole("button", { name: /^reason\b/i }));
    await screen.findByRole("region", { name: /intent structure/i });
    await user.type(input, " now");
    expect(screen.queryByRole("region", { name: /intent structure/i })).not.toBeInTheDocument();
  });

  it("returns to local search while preserving the entered outcome", async () => {
    const user = userEvent.setup();
    render(<App runtime="native" intentReasoner={nativeReasoner()} />);
    const input = screen.getByRole("searchbox", { name: /operator intent/i });
    const intent = "hermes";
    await user.type(input, intent);
    await screen.findByText(/reasoning uses test-model/i);
    await user.click(screen.getByRole("button", { name: /^reason\b/i }));
    await screen.findByRole("region", { name: /intent structure/i });
    await user.click(screen.getByRole("button", { name: /return to local search/i }));
    expect(input).toHaveValue(intent);
    expect(screen.queryByRole("region", { name: /intent structure/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option").length).toBeGreaterThan(2);
  });

  it("supports an explicit pasted-command explanation in operator mode", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "rm -rf ./build");
    await user.click(screen.getByRole("button", { name: /explain pasted command/i }));
    expect(await screen.findByRole("region", { name: /what this does/i })).toBeInTheDocument();
  });

  it.each(["Learn", "Settings"])("returns to Find from %s with web Escape and Header Reset", async (destination) => {
    const user = userEvent.setup();
    render(<App runtime="web" />);
    await user.click(screen.getByRole("button", { name: destination }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Find" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("button", { name: destination }));
    await user.click(screen.getByRole("button", { name: "Reset search" }));
    expect(screen.getByRole("button", { name: "Find" })).toHaveAttribute("aria-current", "page");
  });

  it("shows product guides separately from workflow lessons", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", { name: "Learn" }));
    await user.click(screen.getByRole("tab", { name: /product guides/i }));
    expect(screen.getByRole("button", { name: /^First 10 minutes: Git$/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /lesson/i })).not.toBeInTheDocument();
  });
});
