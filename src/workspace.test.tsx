import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

describe("workspace navigation and preferences", () => {
  it("opens a compact settings surface and persists accessible preferences", async () => {
    window.localStorage.clear();
    const { unmount } = render(<App runtime="web" />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByLabelText("Large text"));
    fireEvent.click(screen.getByLabelText(/keep local history/i));
    await waitFor(() => expect(window.localStorage.getItem("operator-key.preferences.v1")).toContain('"largeText":true'));
    unmount();
    render(<App runtime="web" />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("operator-shell")).toHaveClass("large-text");
    expect(screen.getByLabelText(/keep local history/i)).toBeChecked();
  });
});
