import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => { window.localStorage.clear(); });

function openProductGuides() {
  fireEvent.click(screen.getByRole("button", { name: "Learn" }));
  fireEvent.click(screen.getByRole("tab", { name: "Product guides" }));
}
import { render, screen, fireEvent, within } from "@testing-library/react";
import App from "./App";

function typeQuery(text: string) {
  const input = screen.getByRole("searchbox", { name: /operator intent/i });
  fireEvent.change(input, { target: { value: text } });
  return input;
}

describe("guided onboarding path", () => {
  it("offers a guided route to newcomers in apprentice mode", () => {
    render(<App />);
    openProductGuides();
    expect(screen.getByRole("button", { name: /first 10 minutes: hermes/i })).toBeTruthy();
  });

  it("opens a numbered route with real commands when invited", () => {
    render(<App />);
    openProductGuides();
    fireEvent.click(screen.getByRole("button", { name: /first 10 minutes: hermes/i }));

    const panel = screen.getByRole("region", { name: /first 10 minutes with hermes/i });
    expect(panel).toBeTruthy();
    expect(within(panel).getAllByRole("listitem").length).toBeGreaterThan(2);
    // Every step must teach why, what to do, and what was learned.
    expect(within(panel).getAllByText(/do this:/i).length).toBeGreaterThan(2);
    expect(within(panel).getAllByText(/you learned:/i).length).toBeGreaterThan(2);
  });

  it("states plainly that nothing runs on its own", () => {
    render(<App />);
    openProductGuides();
    fireEvent.click(screen.getByRole("button", { name: /first 10 minutes: hermes/i }));
    expect(screen.getByText(/nothing here runs on its own/i)).toBeTruthy();
  });

  it("closes the route when asked", () => {
    render(<App />);
    openProductGuides();
    fireEvent.click(screen.getByRole("button", { name: /first 10 minutes: hermes/i }));
    fireEvent.click(screen.getByRole("button", { name: /close guided path/i }));
    expect(screen.queryByRole("region", { name: /first 10 minutes with hermes/i })).toBeNull();
  });
});

describe("reverse lookup", () => {
  it("explains a pasted command that is not in the catalog", () => {
    render(<App />);
    typeQuery("tar -xzvf archive.tar.gz");
    fireEvent.click(screen.getByRole("button", { name: /explain pasted command/i }));

    const panel = screen.getByRole("region", { name: /what this does/i });
    expect(within(panel).getByText(/not in catalog/i)).toBeTruthy();
    expect(within(panel).getByText(/piece by piece/i)).toBeTruthy();
  });

  // The safety contract, verified through the real UI rather than the engine alone.
  it("warns about a destructive command even when the catalog does not know it", () => {
    render(<App />);
    typeQuery("rm -rf ./build");
    fireEvent.click(screen.getByRole("button", { name: /explain pasted command/i }));

    const panel = screen.getByRole("region", { name: /what this does/i });
    expect(within(panel).getByText(/before you run this/i)).toBeTruthy();
    expect(within(panel).getByText(/there is no undo/i)).toBeTruthy();
  });

  it("warns when a download is piped straight into a shell", () => {
    render(<App />);
    typeQuery("curl -sSL https://example.com/i.sh | sh");
    fireEvent.click(screen.getByRole("button", { name: /explain pasted command/i }));
    const panel = screen.getByRole("region", { name: /what this does/i });
    expect(within(panel).getByText(/downloads and runs code in one step/i)).toBeTruthy();
  });

  it("does not hijack plain-English intent with a command explanation", () => {
    render(<App />);
    typeQuery("review my code");
    expect(screen.queryByRole("region", { name: /what this does/i })).toBeNull();
  });

  it("stays quiet in operator mode", () => {
    render(<App />);
    typeQuery("rm -rf ./build");
    expect(screen.queryByRole("region", { name: /what this does/i })).toBeNull();
  });

  // Regression: an early heuristic treated any short lowercase phrase as a command, so
  // "review my code" opened a command explanation instead of searching. The search box
  // invites full sentences, so prose must always win unless real syntax is present.
  it("treats plain sentences as intent, not as commands", () => {
    render(<App />);
    for (const sentence of ["check session status", "start a new session", "undo my last change"]) {
      typeQuery(sentence);
      expect(screen.queryByRole("region", { name: /what this does/i })).toBeNull();
    }
  });

  it("still engages for real command syntax", () => {
    render(<App />);
    for (const command of ["git status", "ls -la", "cat notes.txt", "$ hermes chat"]) {
      typeQuery(command);
      fireEvent.click(screen.getByRole("button", { name: /explain pasted command/i }));
      expect(screen.getByRole("region", { name: /what this does/i })).toBeTruthy();
    }
  });
});
