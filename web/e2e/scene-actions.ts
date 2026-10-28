import type { Page } from "@playwright/test";

/** Follow the visible compact Studio menu while retaining ordinary inline actions. */
export async function clickSceneAction(page: Page, name: string): Promise<void> {
  const action = page.getByRole("button", { name, exact: true });
  if (!await action.isVisible()) {
    await page.getByRole("button", { name: "Scene actions", exact: true }).click();
  }
  await action.click();
}
