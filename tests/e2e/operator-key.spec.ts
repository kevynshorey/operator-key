import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __operatorKeyInvocations: Array<{ cmd: string; args: Record<string, unknown> }>;
    __operatorKeyClipboard: string[];
  }
}

async function search(page: Page, query: string) {
  const input = page.getByRole("searchbox", { name: "Operator intent" });
  await input.fill(query);
  return page.getByRole("option", { selected: true });
}

test.beforeEach(async ({ page }, testInfo) => {
  const webMode = testInfo.title.includes("[web]");
  await page.addInitScript(() => {
    window.__operatorKeyInvocations = [];
  });
  if (!webMode) await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
          window.__operatorKeyInvocations.push({ cmd, args });
        },
      },
    });
  });
  if (webMode) await page.addInitScript(() => {
    window.__operatorKeyClipboard = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { window.__operatorKeyClipboard.push(text); } },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Operator intent" })).toBeFocused();
});

test("task-first searches and chord reverse lookup rank expected commands", async ({ page }) => {
  const cases = [
    ["review code", "/code-review"],
    ["resume session", "resume"],
    ["move window", "move window"],
  ] as const;
  for (const [query, expected] of cases) {
    const selected = await search(page, query);
    await expect(selected).toContainText(expected, { ignoreCase: true });
  }

  await search(page, "Ctrl+B");
  const options = page.getByRole("option");
  await expect(options.nth(0)).toHaveAttribute("data-product", "hermes");
  await expect(options.nth(1)).toHaveAttribute("data-product", "claude-code");
  await expect(page.getByLabel("Binding conflict")).toBeVisible();
});

test("product, interface, task, and safety filters compose", async ({ page }) => {
  await search(page, "move window");
  await page.getByRole("radio", { name: /Omarchy/ }).click();
  await page.getByLabel("Interface filter").selectOption("hotkey");
  await page.getByRole("button", { name: "sessions and navigation" }).click();
  await page.getByLabel("Safety filter").selectOption("amber");
  const options = page.getByRole("option");
  await expect(options.first()).toContainText("Move window");
  await expect(options.first()).toContainText("Caution");
  expect(await options.count()).toBeGreaterThan(0);
  for (const option of await options.all()) await expect(option).toHaveAttribute("data-product", "omarchy");
});

test("keyboard selection scrolls, copy works, and Ctrl+Enter is inert", async ({ page }) => {
  const input = page.getByRole("searchbox", { name: "Operator intent" });
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  await expect(page.getByRole("option", { selected: true })).toHaveAttribute("aria-posinset", "3");
  await expect(page.getByRole("option", { selected: true })).toBeInViewport();

  await search(page, "hermes status");
  await input.press("Enter");
  await expect(page.getByRole("status")).toContainText("Copied");
  let calls = await page.evaluate(() => window.__operatorKeyInvocations);
  expect(calls).toEqual([{ cmd: "copy_catalog_command", args: expect.objectContaining({ command: "hermes status" }) }]);

  await input.press("Control+Enter");
  await expect(page.getByRole("status")).toContainText("Execution is disabled");
  calls = await page.evaluate(() => window.__operatorKeyInvocations);
  expect(calls).toHaveLength(1);
});

test("green terminal command inserts while red logout stays copy-only", async ({ page }) => {
  const input = page.getByRole("searchbox", { name: "Operator intent" });
  await search(page, "hermes status");
  await input.press("Shift+Enter");
  await expect(page.getByRole("status")).toContainText("without executing");
  expect(await page.evaluate(() => window.__operatorKeyInvocations)).toEqual([
    { cmd: "insert_catalog_command", args: expect.objectContaining({ command: "hermes status" }) },
  ]);

  await search(page, "hermes logout");
  await expect(page.getByRole("alert")).toContainText("Danger-level (red)");
  await expect(page.getByRole("button", { name: /Insert into confirmed terminal/ })).toBeDisabled();
  await input.press("Shift+Enter");
  await expect(page.getByRole("status")).toContainText("copy-only");
  expect(await page.evaluate(() => window.__operatorKeyInvocations)).toHaveLength(1);
});

test("820x560 large-text mode remains operable and accessible", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 560 });
  await page.getByRole("button", { name: "Large text" }).click();
  await expect(page.getByTestId("operator-shell")).toHaveClass(/large-text/);
  await expect(page.getByRole("radiogroup", { name: "Product lanes" })).toBeVisible();
  await expect(page.getByLabel("Interface filter")).toBeVisible();
  await expect(page.getByLabel("Safety filter")).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Command results" })).toBeVisible();
  await expect(page.getByText("EXECUTION DISABLED", { exact: false })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("[web] browser deck copies safely, gates insertion, and responds at desktop/mobile", async ({ page }) => {
  expect(await page.evaluate(() => "__TAURI_INTERNALS__" in window)).toBe(false);
  const input = page.getByRole("searchbox", { name: "Operator intent" });
  await input.fill("review code");
  await input.press("Enter");
  await expect(page.getByRole("heading", { name: "/code-review" })).toBeVisible();
  expect(await page.evaluate(() => window.__operatorKeyClipboard)).toEqual(["/code-review"]);
  const insert = page.getByRole("button", { name: /Insert into confirmed terminal/ });
  await expect(insert).toBeDisabled();
  await expect(page.getByText(/Install\/open the native Operator Key companion/)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByRole("heading", { name: "/code-review" })).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await expect(page.getByRole("option", { selected: true })).toBeVisible();
  const assertTouchTargets = async () => {
    const controls = page.locator("button, input:not([type=hidden]), select");
    for (let index = 0; index < await controls.count(); index += 1) {
      const box = await controls.nth(index).boundingBox();
      if (!box) continue;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  };
  await assertTouchTargets();
  await input.fill("no matching command sentinel query");
  await expect(page.getByRole("heading", { name: "No matching command" })).toBeVisible();
  await assertTouchTargets();
});

test("[web] mobile keyboard navigation scrolls only the result list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const input = page.getByRole("searchbox", { name: "Operator intent" });
  await input.fill("review");
  await page.evaluate(() => window.scrollTo(0, 0));
  const resultList = page.getByRole("listbox", { name: "Command results" });
  const initialListScroll = await resultList.evaluate((element) => element.scrollTop);
  for (let index = 0; index < 8; index += 1) await input.press("ArrowDown");
  await expect.poll(() => resultList.evaluate((element) => element.scrollTop)).toBeGreaterThan(initialListScroll);
  expect(await page.evaluate(() => ({ windowY: window.scrollY, documentY: document.documentElement.scrollTop }))).toEqual({ windowY: 0, documentY: 0 });
});

test("[web] 390px deck exposes rail affordances and the dominant recommendation above the fold", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const input = page.getByRole("searchbox", { name: "Operator intent" });
  await input.fill("review code");

  const productRail = page.getByRole("radiogroup", { name: "Product lanes" });
  const taskRail = page.getByLabel("Task filters");
  await expect(productRail).toHaveAttribute("data-scroll-affordance", "horizontal");
  await expect(taskRail).toHaveAttribute("data-scroll-affordance", "horizontal");
  for (const rail of [productRail, taskRail]) {
    const metrics = await rail.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        overflowX: style.overflowX,
        paddingRight: Number.parseFloat(style.paddingRight),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    });
    expect(metrics.overflowX).toBe("auto");
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
    expect(metrics.paddingRight).toBeGreaterThanOrEqual(32);
  }

  for (const [query, heading] of [["review code", "/code-review"], ["/claude-api", "/claude-api"], ["/doctor", "/doctor"], ["/bug", "/bug"]] as const) {
    await input.fill(query);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeInViewport();
    await expect(page.locator(".detail-card .safety-pill")).toBeInViewport();
    await expect(page.locator(".detail-description")).toBeInViewport();
    const descriptionBox = await page.locator(".detail-description").boundingBox();
    expect(descriptionBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(844);
    expect((descriptionBox?.y ?? 0) + (descriptionBox?.height ?? 0)).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
