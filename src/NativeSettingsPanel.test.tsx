import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NativeSettingsPanel } from "./NativeSettingsPanel";

const disabled = { enabled: false, provider: "disabled", model: "", endpoint: "http://127.0.0.1:11434", timeout_seconds: 90 };
function bridge() {
  let settings = { ...disabled };
  return vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === "get_reasoning_settings") return settings;
    if (command === "catalog_health") return { source: "embedded", failure: "malformed" };
    if (command === "save_reasoning_settings") { settings = args?.settings as typeof settings; return settings; }
    if (command === "reset_reasoning_settings") { settings = { ...disabled }; return settings; }
    if (command === "reason_about_intent") return { summary: "Connection works", recommendations: [] };
    throw new Error("unexpected IPC");
  });
}
describe("NativeSettingsPanel", () => {
  it("does not call native APIs in the browser", () => {
    const invoke = bridge();
    render(<NativeSettingsPanel runtime="web" nativeInvoke={invoke} />);
    expect(screen.getByText(/native app to configure/i)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("shows catalog fallback and saves then verifies local settings", async () => {
    const invoke = bridge(); const changed = vi.fn(); const user = userEvent.setup();
    render(<NativeSettingsPanel runtime="native" nativeInvoke={invoke} onChanged={changed} testCandidateId="safe-id" />);
    expect(await screen.findByText(/local catalog is malformed/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Local model provider"), "ollama");
    await user.type(screen.getByLabelText("Model identifier"), "local-model");
    await user.click(screen.getByLabelText("Enable local reasoning"));
    await user.click(screen.getByRole("button", { name: "Save reasoning settings" }));
    expect(await screen.findByText(/settings saved and verified/i)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("save_reasoning_settings", { settings: { ...disabled, enabled: true, provider: "ollama", model: "local-model" } });
    expect(changed).toHaveBeenCalledOnce();
    expect(invoke.mock.calls.filter(([c]) => c === "get_reasoning_settings")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Test local model" }));
    expect(await screen.findByText(/model answered the sample request/i)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("reason_about_intent", { intent: "Explain the selected catalog command without executing anything.", candidateIds: ["safe-id"] });
  });
  it("refuses remote endpoints before save even when disabled", async () => {
    const invoke = bridge(); const user = userEvent.setup();
    render(<NativeSettingsPanel runtime="native" nativeInvoke={invoke} />);
    const endpoint = await screen.findByLabelText("Loopback endpoint");
    await user.clear(endpoint); await user.type(endpoint, "http://example.com:11434");
    await user.click(screen.getByRole("button", { name: "Save reasoning settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/loopback/i);
    expect(invoke.mock.calls.some(([c]) => c === "save_reasoning_settings")).toBe(false);
  });
  it("requires an explicit confirmation before resetting", async () => {
    const invoke = bridge(); const user = userEvent.setup();
    render(<NativeSettingsPanel runtime="native" nativeInvoke={invoke} />);
    await screen.findByLabelText("Loopback endpoint");
    await user.click(screen.getByRole("button", { name: "Reset reasoning" }));
    expect(invoke.mock.calls.some(([c]) => c === "reset_reasoning_settings")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm reset" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("reset_reasoning_settings"));
    expect(await screen.findByText(/reasoning reset and verified disabled/i)).toBeInTheDocument();
  });
  it("does not echo malformed or secret-bearing native response fields", async () => {
    const invoke = vi.fn(async () => ({ ...disabled, endpoint: "http://user:secret@127.0.0.1" }));
    render(<NativeSettingsPanel runtime="native" nativeInvoke={invoke} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);
    expect(screen.queryByDisplayValue(/secret/)).not.toBeInTheDocument();
  });
  it("does not expose legacy Codex disclosure for a disabled provider", async () => {
    render(<NativeSettingsPanel runtime="native" nativeInvoke={bridge()} />);
    await screen.findByLabelText("Loopback endpoint");
    expect(screen.queryByText(/legacy codex/i)).not.toBeInTheDocument();
  });
});
