export type OperatorRuntime = "native" | "web";

type TauriWindow = Window & { __TAURI_INTERNALS__?: { invoke?: unknown } };

export function detectRuntime(target: Window = window): OperatorRuntime {
  const internals = (target as TauriWindow).__TAURI_INTERNALS__;
  return internals && typeof internals.invoke === "function" ? "native" : "web";
}
