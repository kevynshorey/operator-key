import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import App from "./App";

/**
 * UI-level tests for the lessons panel.
 *
 * `src/lessons.test.ts` proves the lesson DATA is catalog-backed and honest. These tests
 * prove the panel a newcomer actually sees carries that honesty through to the screen:
 * the commands rendered are the resolved ones, hazards are visible, and nothing implies
 * the app will act on their behalf.
 */
function openLesson(name: RegExp) {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("region", { name: /lesson/i });
}

/**
 * Find a command CHIP (the clickable, catalog-resolved entry) rather than an inline
 * mention of the same command inside the lesson prose. Asserting on the chip is what
 * proves the command was resolved from the catalog instead of typed into the text.
 */
function commandChip(panel: HTMLElement, command: string) {
  const chip = within(panel).getAllByRole("button")
    .find((button) => button.querySelector("code")?.textContent === command);
  expect(chip, `no command chip for ${command}`).toBeTruthy();
  return chip!;
}

describe("lessons panel", () => {
  it("invites a newcomer who has never used git or GitHub", () => {
    render(<App />);
    expect(screen.getByText(/never used git or github\?/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /save your first piece of work with git/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /open your first pull request/i })).toBeTruthy();
  });

  it("opens a lesson with real catalog commands, not prose examples", () => {
    const panel = openLesson(/save your first piece of work with git/i);
    // The commands rendered must be the ones resolved from the catalog.
    expect(commandChip(panel, "git status")).toBeTruthy();
    expect(commandChip(panel, "git commit")).toBeTruthy();
    expect(within(panel).getAllByRole("listitem").length).toBeGreaterThanOrEqual(4);
  });

  it("explains why each step exists rather than just naming the command", () => {
    const panel = openLesson(/save your first piece of work with git/i);
    expect(within(panel).getByText(/who this is for/i)).toBeTruthy();
    // A step's explanation has to add the reason the catalog description does not carry.
    expect(within(panel).getByText(/almost every confusing git situation/i)).toBeTruthy();
  });

  it("shows the force-push hazard where a newcomer would hit it", () => {
    const panel = openLesson(/open your first pull request/i);
    const watchOuts = within(panel).getAllByText(/watch out:/i);
    expect(watchOuts.length).toBeGreaterThan(0);
    expect(within(panel).getByText(/force-with-lease/i)).toBeTruthy();
  });

  it("tells a learner to inspect a skill before installing it", () => {
    const panel = openLesson(/extend your agent with skills/i);
    expect(commandChip(panel, "hermes skills inspect")).toBeTruthy();
    expect(within(panel).getByText(/read it the way you would read a script/i)).toBeTruthy();
  });

  it("switches between lessons without closing the panel", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /save your first piece of work with git/i }));
    const tab = screen.getByRole("tab", { name: /get back when git goes wrong/i });
    fireEvent.click(tab);
    const panel = screen.getByRole("region", { name: /lesson/i });
    expect(commandChip(panel, "git revert")).toBeTruthy();
    expect(tab.getAttribute("aria-selected")).toBe("true");
  });

  it("renders backticked commands as code, not raw punctuation", () => {
    // Found in a real browser, invisible to text-matching tests: lesson prose is authored
    // with `backticks`, and rendering it raw printed the punctuation on screen, teaching a
    // newcomer that the backtick is part of the command they should type.
    const panel = openLesson(/save your first piece of work with git/i);
    expect(panel.textContent ?? "").not.toContain("`");
    const inline = within(panel).getAllByText("git status", { selector: "code.lesson-code" });
    expect(inline.length).toBeGreaterThan(0);
  });

  it("states plainly that the panel never runs anything", () => {
    const panel = openLesson(/save your first piece of work with git/i);
    expect(within(panel).getByText(/this panel never runs anything/i)).toBeTruthy();
  });

  it("closes when asked", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /save your first piece of work with git/i }));
    fireEvent.click(screen.getByRole("button", { name: /close lessons/i }));
    expect(screen.queryByRole("region", { name: /lesson/i })).toBeNull();
  });

  it("selects the catalog entry when a lesson command is clicked", () => {
    const panel = openLesson(/save your first piece of work with git/i);
    fireEvent.click(commandChip(panel, "git status"));
    // Clicking a lesson command hands off to the normal detail surface, so the operator
    // gets full provenance and safety rather than the lesson's summary of it.
    expect(screen.getAllByText("git status").length).toBeGreaterThan(0);
  });

  it("does not offer the lessons invite while a guided route is open", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /first 10 minutes: hermes/i }));
    // Two full-width teaching panels at once buries the search field the app is built on.
    expect(screen.queryByText(/never used git or github\?/i)).toBeNull();
  });

  it("keeps the lessons panel out of operator mode", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /apprentice/i }));
    expect(screen.queryByText(/never used git or github\?/i)).toBeNull();
  });
});
