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

async function operatorActionCalls(page: Page) {
  return page.evaluate(() => window.__operatorKeyInvocations.filter(({ cmd }) => ["copy_catalog_command", "insert_catalog_command"].includes(cmd)));
}

test.beforeEach(async ({ page }, testInfo) => {
  const webMode = testInfo.title.includes("[web]");
  const disabledReasoning = testInfo.title.includes("[native-disabled]");
  const degradedDesktop = testInfo.title.includes("[degraded-desktop]");
  await page.addInitScript(() => {
    window.__operatorKeyInvocations = [];
  });
  if (!webMode) await page.addInitScript(({ disabledReasoning, degradedDesktop }) => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
          window.__operatorKeyInvocations.push({ cmd, args });
          if (cmd === "desktop_capabilities") return degradedDesktop ? { canCopy: true, canInsert: false } : { canCopy: true, canInsert: true };
          if (cmd === "desktop_compatibility") return degradedDesktop ? {
            mode: "degraded",
            capabilities: { canCopy: true, canInsert: false },
            searchAvailable: true,
            requirements: [
              { feature: "search", met: true, unmetPrerequisites: [] },
              { feature: "copy", met: true, unmetPrerequisites: [] },
              { feature: "insert", met: false, unmetPrerequisites: ["Hyprland, for the window IPC that confirms the target terminal", "wtype, on PATH"] },
            ],
          } : {
            mode: "supported",
            capabilities: { canCopy: true, canInsert: true },
            searchAvailable: true,
            requirements: [
              { feature: "search", met: true, unmetPrerequisites: [] },
              { feature: "copy", met: true, unmetPrerequisites: [] },
              { feature: "insert", met: true, unmetPrerequisites: [] },
            ],
          };
          if (cmd === "catalog_snapshot") return null;
          if (cmd === "spark_intent_status") return {
            available: !disabledReasoning,
            loggedIn: !disabledReasoning,
            model: disabledReasoning ? "" : "gpt-5.6-luna",
            provider: disabledReasoning ? "disabled" : "codex",
            configPath: "/mock/native/reasoning.json",
            message: disabledReasoning ? "Reasoning is off. Search works without it." : "Luna ready.",
          };
          if (cmd === "reason_about_intent") return {
            model: "gpt-5.6-luna",
            summary: "Inspect agent health before opening an interactive session.",
            assumptions: ["Codex CLI is authenticated."],
            gaps: ["The target workspace is not specified."],
            recommendations: [
              { entryId: "16fe16d89f85e6a8", sequence: 1, purpose: "Check agent health.", inputHint: "No input required.", confidence: "high" },
              { entryId: "bba8772153ddeadc", sequence: 2, purpose: "Start an interactive session.", inputHint: "Continue with the workspace goal.", confidence: "medium" },
            ],
          };
        },
      },
    });
  }, { disabledReasoning, degradedDesktop });
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

test("empty Find offers task starters that only narrow search", async ({ page }) => {
  const starters = page.getByLabel("Task starters");
  await expect(starters).toBeVisible();
  await starters.getByRole("button", { name: "sessions and navigation" }).click();
  await expect(page.getByRole("searchbox", { name: "Operator intent" })).toHaveValue("sessions and navigation");
  await expect(page.getByRole("option", { selected: true })).toContainText("Move", { ignoreCase: true });
  await expect(starters).toHaveCount(0);
  expect(await operatorActionCalls(page)).toHaveLength(0);
});

test("[native-disabled] native configuration handoff focuses Optional local reasoning", async ({ page }) => {
  await page.getByRole("button", { name: "Configure reasoning" }).click();
  const settings = page.getByRole("region", { name: "Optional local reasoning" });
  await expect(settings).toBeFocused();
  await expect(settings).toBeInViewport();
});

test("[native-disabled] Settings reports conservative desktop readiness", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const readiness = page.getByRole("region", { name: "Desktop readiness" });
  await expect(readiness).toContainText("Local catalog search: Available");
  await expect(readiness).toContainText("Native copy: Ready");
  await expect(readiness).toContainText("Terminal insertion: Ready");
  await expect(readiness).toContainText("does not press Enter");
  await expect(page.getByText(/Provider disclosure:/)).toHaveCount(0);
});

test("[native-disabled] Settings states what this build is without leaking a path", async ({ page }) => {
  // Text-matching tests cannot prove this renders legibly or in the right place; the
  // flex-order and ARIA defects in the previous slice were only visible in a browser.
  await page.getByRole("button", { name: "Settings" }).click();
  const build = page.getByRole("region", { name: "This build" });

  await expect(build).toBeVisible();
  await expect(build).toContainText("Version:");

  // The panel is what an operator screenshots into a bug report.
  await expect(build).not.toContainText("/home/");
  await expect(build).not.toContainText("/Users/");

  // It must sit inside Settings, above desktop readiness, not floating at the top of the
  // pane where it would read as a header for the whole app.
  const buildBox = await build.boundingBox();
  const readinessBox = await page
    .getByRole("region", { name: "Desktop readiness" })
    .boundingBox();
  expect(buildBox).not.toBeNull();
  expect(readinessBox).not.toBeNull();
  expect(buildBox!.y).toBeLessThan(readinessBox!.y);

  // Narrow window: the instruction must wrap rather than overflow horizontally.
  await page.setViewportSize({ width: 380, height: 700 });
  const narrow = await build.boundingBox();
  expect(narrow!.width).toBeLessThanOrEqual(380);
  await page.setViewportSize({ width: 1024, height: 768 });
});

test("[native-disabled] Settings offers preview-first shortcut setup without an in-app apply", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const shortcut = page.getByRole("region", { name: "Global shortcut" });

  // Exactly one displayed command across the whole page, independent of any CSS class:
  // an unclassed code block or plain prose would slip past a class-based count.
  const body = await page.locator("body").innerText();
  expect(body.match(/install-omarchy-binding\.py/g) ?? []).toHaveLength(1);
  expect(body).not.toMatch(/install-omarchy-binding\.py\s+--apply/);
  await expect(page.locator(".shortcut-command")).toHaveCount(1);
  // The exact command, with nothing beside it: whatever sits on this line is what a
  // reader copies into a terminal to change their desktop configuration.
  await expect(shortcut.locator(".shortcut-command")).toHaveText("python3 scripts/install-omarchy-binding.py");
  await expect(shortcut).toContainText("read-only");
  await expect(shortcut).toContainText("does not change your desktop configuration");

  // Compositor changes stay behind the installer's typed confirmation in a terminal:
  // no in-app control may become an alternative path to applying them.
  await expect(shortcut.getByRole("button")).toHaveCount(0);
});

test("[web] the browser build does not advertise the Hyprland shortcut installer", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("region", { name: "Global shortcut" })).toHaveCount(0);
});

test("[native-disabled] a fully supported desktop lists no prerequisites to install", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const readiness = page.getByRole("region", { name: "Desktop readiness" });
  await expect(readiness).toContainText("Fully supported");
  // Nothing to fix here, so the guidance must stay out of the way.
  await expect(readiness).not.toContainText("To enable");
});

test("[degraded-desktop] Settings names the exact prerequisite for an unavailable action", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const readiness = page.getByRole("region", { name: "Desktop readiness" });

  // A partly supported desktop must stay usable, and say precisely what is missing.
  await expect(readiness).toContainText("Partly supported");
  await expect(readiness).toContainText("Local catalog search: Available");
  await expect(readiness).toContainText("wtype, on PATH");
  await expect(readiness).toContainText("Hyprland, for the window IPC that confirms the target terminal");
  // The report is screenshot-safe: it must never expose the operator's environment.
  await expect(readiness).not.toContainText("/home/");
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
  await expect(page.locator(".action-status")).toContainText("Copied");
  let calls = await operatorActionCalls(page);
  expect(calls).toEqual([{ cmd: "copy_catalog_command", args: expect.objectContaining({ command: "hermes status" }) }]);

  await input.press("Control+Enter");
  await expect(page.getByRole("status")).toContainText("Execution is disabled");
  calls = await operatorActionCalls(page);
  expect(calls).toHaveLength(1);
});

test("green terminal command inserts while red logout stays copy-only", async ({ page }) => {
  const input = page.getByRole("searchbox", { name: "Operator intent" });
  await search(page, "hermes status");
  await input.press("Shift+Enter");
  await expect(page.getByRole("status")).toContainText("without executing");
  expect(await operatorActionCalls(page)).toEqual([
    { cmd: "insert_catalog_command", args: expect.objectContaining({ command: "hermes status" }) },
  ]);

  await search(page, "hermes logout");
  await expect(page.getByRole("alert")).toContainText("Danger-level (red)");
  await expect(page.getByRole("button", { name: /Insert into confirmed terminal/ })).toBeDisabled();
  await input.press("Shift+Enter");
  await expect(page.getByRole("status")).toContainText("copy-only");
  expect(await operatorActionCalls(page)).toHaveLength(1);
});

test("Luna structures a sentence into exact ordered catalog commands without executing", async ({ page }) => {
  const input = page.getByRole("searchbox", { name: "Operator intent" });
  const intent = "Check whether Hermes is healthy, then open an interactive session so I can continue working.";
  await input.fill(intent);
  await expect(page.getByText("Luna ready.")).toBeVisible();
  await input.press("Alt+Enter");

  const structure = page.getByRole("region", { name: "Intent structure" });
  await expect(structure).toBeVisible();
  await expect(structure).toContainText("Inspect agent health before opening an interactive session.");
  await expect(structure).toContainText("Codex CLI is authenticated.");
  await expect(structure).toContainText("The target workspace is not specified.");
  const options = page.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("hermes status");
  await expect(options.nth(1)).toContainText("hermes chat");
  await expect(page.getByRole("heading", { name: "hermes status", exact: true })).toBeVisible();

  const reasoningCall = (await page.evaluate(() => window.__operatorKeyInvocations)).find(({ cmd }) => cmd === "reason_about_intent");
  expect(reasoningCall?.args.intent).toBe(intent);
  expect(reasoningCall?.args.candidateIds).toEqual(expect.arrayContaining(["16fe16d89f85e6a8", "bba8772153ddeadc"]));
  expect((reasoningCall?.args.candidateIds as string[]).length).toBeLessThanOrEqual(220);
  expect(await operatorActionCalls(page)).toHaveLength(0);

  await input.press("Enter");
  await expect(page.locator(".action-status")).toContainText("Copied");
  expect(await operatorActionCalls(page)).toEqual([
    { cmd: "copy_catalog_command", args: expect.objectContaining({ entryId: "16fe16d89f85e6a8", command: "hermes status" }) },
  ]);
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
