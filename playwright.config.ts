import { defineConfig } from "@playwright/test";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const useNativeSharedMemory = env.OPERATOR_KEY_PLAYWRIGHT_USE_DEV_SHM === "1";
// CI installs Playwright's matching browser. Local Omarchy may use system Chromium.
const executablePath = env.OPERATOR_KEY_CHROMIUM_PATH ?? (env.CI ? undefined : "/usr/bin/chromium");

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
      ...(executablePath ? { executablePath } : {}),
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
