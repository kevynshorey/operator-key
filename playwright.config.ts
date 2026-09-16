import { defineConfig } from "@playwright/test";

const useNativeSharedMemory = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.OPERATOR_KEY_PLAYWRIGHT_USE_DEV_SHM === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    launchOptions: {
      executablePath: "/usr/bin/chromium",
      ...(useNativeSharedMemory ? { ignoreDefaultArgs: ["--disable-dev-shm-usage"] } : {}),
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
