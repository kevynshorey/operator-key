import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => { window.localStorage.clear(); });

function useApprenticeMode() {
  window.localStorage.setItem("operator-key.preferences.v1", JSON.stringify({ apprenticeMode: true }));
}
import App from "./App";

/**
 * These tests exercise the apprentice surface through the real UI: ghost text,
 * Tab acceptance, the anatomy breakdown, and the follow-up ladder. They use the
 * shipped catalog so a regression in the data also fails here.
 */
describe("Apprentice learning surface", () => {
  it("shows a ghost completion and accepts it with Tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    const search = await screen.findByRole("searchbox", { name: /operator intent/i });
    await user.type(search, "review");

    const hint = await screen.findByText(/suggested completion:/i);
    expect(hint).toBeInTheDocument();

    await user.keyboard("{Tab}");
    // Tab commits the predicted phrase into the field rather than moving focus.
    expect((search as HTMLInputElement).value.length).toBeGreaterThan("review".length);
    expect((search as HTMLInputElement).value.startsWith("review")).toBe(true);
  });

  it("offers starter prompts before anything is typed and loads one on click", async () => {
    const user = userEvent.setup();
    render(<App />);

    const starters = await screen.findByLabelText(/task starters/i);
    const [firstStarter] = within(starters).getAllByRole("button");
    const label = firstStarter.textContent ?? "";
    expect(label.length).toBeGreaterThan(0);

    await user.click(firstStarter);
    const search = screen.getByRole("searchbox", { name: /operator intent/i });
    expect((search as HTMLInputElement).value).toBe(label);
  });

  it("explains the selected command's anatomy and concepts", async () => {
    useApprenticeMode();
    const user = userEvent.setup();
    render(<App />);

    const search = await screen.findByRole("searchbox", { name: /operator intent/i });
    await user.type(search, "review my code");

    const learnPanel = await screen.findByRole("region", { name: /learn/i });
    expect(within(learnPanel).getByText(/anatomy — what each part means/i)).toBeInTheDocument();

    // Every command must break into at least one explained token, and each token
    // must carry a role label plus a plain-language explanation — that is the lesson.
    const tokens = within(learnPanel).getAllByRole("listitem");
    expect(tokens.length).toBeGreaterThan(0);
    const [firstToken] = tokens;
    expect(firstToken.querySelector("code")?.textContent ?? "").not.toBe("");
    expect(firstToken.querySelector(".token-role")?.textContent ?? "").not.toBe("");
    expect((firstToken.querySelector("p")?.textContent ?? "").length).toBeGreaterThan(10);

    expect(within(learnPanel).getByText(/safety ·/i)).toBeInTheDocument();
  });

  it("proposes follow-up checks and navigates to a follow-up command", async () => {
    useApprenticeMode();
    const user = userEvent.setup();
    render(<App />);

    const search = await screen.findByRole("searchbox", { name: /operator intent/i });
    await user.type(search, "commit my changes");

    const nextMoves = await screen.findByRole("region", { name: /next moves/i });
    expect(within(nextMoves).getByText(/running the command is one step/i)).toBeInTheDocument();

    const actionButtons = within(nextMoves).getAllByRole("button");
    expect(actionButtons.length).toBeGreaterThan(0);
  });

  it("toggles between apprentice and operator density", async () => {
    const user = userEvent.setup();
    render(<App />);

    const toggle = await screen.findByRole("button", { name: /operator/i });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);
    const apprenticeToggle = screen.getByRole("button", { name: /apprentice/i });
    expect(apprenticeToggle).toHaveAttribute("aria-pressed", "true");
  });

  it("never renders an execution control in the learning panels", async () => {
    useApprenticeMode();
    const user = userEvent.setup();
    render(<App />);

    const search = await screen.findByRole("searchbox", { name: /operator intent/i });
    await user.type(search, "delete a branch");

    const nextMoves = await screen.findByRole("region", { name: /next moves/i });
    const buttons = within(nextMoves).getAllByRole("button");
    for (const button of buttons) {
      expect(button.textContent ?? "").not.toMatch(/\brun\b|\bexecute\b/i);
    }
  });
});
