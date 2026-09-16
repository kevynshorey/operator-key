import { afterEach, describe, expect, it } from "vitest";
import { detectRuntime } from "./runtime";

afterEach(() => Reflect.deleteProperty(window, "__TAURI_INTERNALS__"));

describe("runtime detection", () => {
  it("detects ordinary browsers as web", () => expect(detectRuntime()).toBe("web"));

  it("detects Tauri only when its invoke boundary exists", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke() {} } });
    expect(detectRuntime()).toBe("native");
  });

  it("does not trust a partial Tauri-shaped global", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    expect(detectRuntime()).toBe("web");
  });
});
