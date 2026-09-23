import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => { await page.goto("/"); });

test("Find is compact with a visible primary action at native and mobile sizes", async ({ page }) => {
  for (const viewport of [{ width: 1120, height: 720 }, { width: 820, height: 560 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("searchbox", { name: "Operator intent" }).fill("hermes status");
    await expect(page.getByRole("heading", { name: "hermes status", exact: true })).toBeInViewport();
    await expect(page.getByRole("button", { name: /Copy command/ })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  }
});

test("readability and learning preferences survive reload", async ({ page }) => {
  await page.getByRole("button", { name: "Large text", exact: true }).click();
  await page.reload();
  await expect(page.getByTestId("operator-shell")).toHaveClass(/large-text/);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByText(/native app to configure/i)).toBeVisible();
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Operator intent" })).toBeVisible();
});

test("favorites survive reopening and resolve their exact catalog command", async ({ page }) => {
  await page.getByRole("searchbox", { name: "Operator intent" }).fill("hermes status");
  await expect(page.getByRole("heading", { name: "hermes status", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save favorite", exact: true }).click();
  await page.reload();
  await page.locator(".quick-library summary").filter({ hasText: "Favorites" }).click();
  await page.locator(".quick-library").getByRole("button", { name: /hermes status/ }).click();
  await expect(page.getByRole("heading", { name: "hermes status", exact: true })).toBeVisible();
});

test("Learn is separate from Find and still exposes product guides", async ({ page }) => {
  await expect(page.getByRole("button", { name: "First 10 minutes: Hermes" })).not.toBeVisible();
  await page.getByRole("button", { name: "Learn", exact: true }).click();
  await page.getByRole("tab", { name: "Product guides", exact: true }).click();
  await expect(page.getByRole("button", { name: "First 10 minutes: Hermes" })).toBeVisible();
  await page.getByRole("button", { name: "First 10 minutes: Hermes" }).click();
  await expect(page.getByText(/First 10 minutes/i).first()).toBeVisible();
});
