import { detectRuntime } from "./runtime";

export type HideOverlay = () => void | Promise<void>;

export async function hideOverlay(): Promise<void> {
  if (detectRuntime() !== "native") return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}
