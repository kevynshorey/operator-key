import { afterEach, describe, expect, it, vi } from "vitest";

const windowHandle = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  hide: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowHandle,
}));

import { hideOverlay } from "./overlay";

describe("overlay dismissal", () => {
  afterEach(() => {
    windowHandle.close.mockClear();
    windowHandle.hide.mockClear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("closes the Tauri process so a global launcher remains reusable", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });

    await hideOverlay();

    expect(windowHandle.close).toHaveBeenCalledOnce();
    expect(windowHandle.hide).not.toHaveBeenCalled();
  });

  it("is a no-op in the browser preview", async () => {
    await hideOverlay();
    expect(windowHandle.close).not.toHaveBeenCalled();
  });
});
