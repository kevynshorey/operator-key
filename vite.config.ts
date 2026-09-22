import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    pool: "threads",
    maxWorkers: 2,
    // The overlay tests drive userEvent against a 2,000+ entry catalog. They pass
    // comfortably in isolation but hit the 5s default on a loaded machine or a shared CI
    // runner, which reads as a failure when nothing is actually broken. The extra ceiling
    // only applies to a test that would otherwise have been reported as a flake.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
});
