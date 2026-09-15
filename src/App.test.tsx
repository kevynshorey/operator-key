import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

afterEach(() => {
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("Operator Key overlay", () => {
  it("renders the keyboard-first search shell and catalog status", () => {
    render(<App />);
    expect(screen.getByRole("searchbox", { name: /operator intent/i })).toHaveFocus();
    expect(screen.getByRole("radiogroup", { name: /product lanes/i })).toBeInTheDocument();
    expect(screen.getByText(/1,302 commands ready/i)).toBeInTheDocument();
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

  it("keeps the keyboard-active result visible as selection changes", async () => {
    const scrolledIds: string[] = [];
    const scrollIntoView = vi.fn(function (this: Element, options?: ScrollIntoViewOptions) {
      scrolledIds.push(`${this.id}:${options?.block}`);
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockClear();
    scrolledIds.length = 0;
    const search = screen.getByRole("searchbox", { name: /operator intent/i });
    await user.type(search, "review code");
    await user.keyboard("{ArrowDown}");

    const active = screen.getByRole("option", { selected: true });
    await waitFor(() => expect(scrolledIds.at(-1)).toBe(`${active.id}:nearest`));
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
  });

  it("dismisses once with Escape from controls outside the search input", async () => {
    const user = userEvent.setup();
    const hideOverlay = vi.fn();
    render(<App hideOverlay={hideOverlay} />);

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
    render(<App hideOverlay={hideOverlay} />);
    await user.click(screen.getByRole("button", { name: /close operator key/i }));
    expect(hideOverlay).toHaveBeenCalledOnce();
  });

  it("provides filters and an explicit empty state", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.selectOptions(screen.getByLabelText(/safety filter/i), "red");
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "move window");
    expect(screen.getByRole("status")).toHaveTextContent(/no matching command/i);
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
    render(<App actions={actions} />);
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
    render(<App actions={actions} />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "hermes logout");
    expect(screen.getByRole("alert")).toHaveTextContent(/danger|red/i);
    expect(screen.getByRole("button", { name: /insert into confirmed terminal/i })).toBeDisabled();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(actions.insert).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/copy-only/i);
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
    expect(screen.getAllByRole("option").every((option) => option.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(screen.getAllByRole("button", { name: /task/i }).every((control) => control.hasAttribute("disabled"))).toBe(true);

    finishCopy?.();
    expect(await screen.findByRole("status")).toHaveTextContent(/copied “hermes chat”/i);
    await waitFor(() => expect(search).not.toBeDisabled());
  });

  it("associates the disabled insertion explanation with the control", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole("searchbox", { name: /operator intent/i }), "hermes logout");

    const insert = screen.getByRole("button", { name: /insert into confirmed terminal/i });
    expect(insert).toHaveAttribute("aria-describedby", "insert-disabled-reason");
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
    expect(screen.getByText(/binding conflict/i)).toBeInTheDocument();
    expect(screen.getByText(/safety level/i)).toBeInTheDocument();
    expect(screen.getByText(/version/i)).toBeInTheDocument();
    expect(screen.getByText(/provenance/i)).toBeInTheDocument();
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
});
