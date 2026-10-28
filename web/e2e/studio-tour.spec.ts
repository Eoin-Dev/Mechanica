import { expect, test } from "@playwright/test";

for (const layout of [
  { name: "enlarged phone", width: 320, height: 640, scale: 2 },
  { name: "short landscape", width: 844, height: 390, scale: 1.2 },
]) {
  test.describe(`Studio tutorial ${layout.name}`, () => {
    test.use({ viewport: { width: layout.width, height: layout.height }, hasTouch: true });
    test("each Inspector explanation keeps its real control visible beside the tour card", async ({ page }, info) => {
      await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({
        tour_done: true, studio_mode: true, theme: "light", font_scale: 1.2,
      })));
      await page.goto("/");
      await page.evaluate(scale => document.documentElement.style.setProperty("--fs", String(scale)), layout.scale);
      await page.locator("#btn-settings").click();
      await page.getByRole("button", { name: "Replay the tour", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Guided tour", exact: true });
      for (let i = 0; i < 10; i++) {
        await expect(dialog.locator(".tour-step")).toHaveText(`${i + 1} of 10`);
        const title = await dialog.locator("h3").innerText();
        const target = title === "Edit particles and rods" ? page.locator(".inspector-object-head") :
          title === "Read a free-body diagram" ? page.locator(".force-toggle") :
          title === "Measure the motion" ? page.getByRole("combobox", { name: "Graph shown in the dock", exact: true }) :
          title === "Write your own physics" ? page.getByRole("button", { name: "Add force field", exact: true }) : null;
        if (target) {
          await expect(target).toBeInViewport({ ratio: .95 });
          await page.screenshot({ path: info.outputPath(`studio-tour-${i + 1}.png`) });
          await expect.poll(async () => {
            const a = (await target.boundingBox())!, b = (await dialog.boundingBox())!;
            const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
              Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
            return overlap / (a.width * a.height);
          }).toBeLessThan(.01);
          if (await dialog.evaluate(el => el.scrollHeight - el.clientHeight > 40)) {
            await dialog.evaluate(el => { el.scrollTop = 40; });
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBeGreaterThan(20);
          }
        }
        await dialog.getByRole("button", { name: i === 9 ? "Get started" : "Next", exact: true }).click();
      }
      await expect(dialog).toBeHidden();
    });
  });
}
