import { expect, test, type Page } from "@playwright/test";

async function recoveredScene(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    return JSON.parse(JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!).scene);
  });
}

for (const [theme, studio, width, scale] of [
  ["dark", false, 1440, 1], ["light", false, 1440, 0.8],
  ["light", true, 1440, 1.2], ["dark", true, 1024, 1],
  ["light", true, 390, 1.2], ["void", false, 390, 1],
] as const) {
  test.describe(() => {
    test.use({ viewport: { width, height: 900 } });

    test(`editable identity and compact Studio tools (${theme}, Studio=${studio}, ${width}px, scale=${scale})`, async ({ page }, info) => {
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(settings => localStorage.setItem("mechanica.settings", JSON.stringify(settings)),
        { tour_done: true, theme, studio_mode: studio, font_scale: scale });
      await page.goto("/");
      const open = page.getByRole("button", { name: "Open Inspector", exact: true });
      if (await open.isVisible()) await open.click();
      const name = page.getByRole("textbox", { name: "Name", exact: true });
      await expect(name).toHaveCount(1);
      const original = await name.inputValue();
      await page.locator(".inspector-object-head .inspector-particle-cue").click();
      await expect(name).toBeFocused();
      await name.fill("Mass <α> 📐"); await name.press("Enter");
      await expect.poll(async () => (await recoveredScene(page)).bodies.some((body: { name: string }) => body.name === "Mass <α> 📐"))
        .toBe(true);
      expect(await page.locator(".inspector-object-card").evaluate(el => {
        const style = getComputedStyle(el); return [style.borderTopWidth, style.borderLeftWidth];
      })).toEqual(["0px", "0px"]);
      const metrics = await page.locator("#palette").evaluate(el => ({
        width: el.getBoundingClientRect().width,
        tools: [...el.querySelectorAll<HTMLElement>(".tool-btn")].map(button => ({
          width: button.getBoundingClientRect().width,
          label: button.querySelector<HTMLElement>(".tool-name")?.getBoundingClientRect().width ?? 0,
        })),
      }));
      if (studio && width > 1100) {
        expect(metrics.width).toBeLessThanOrEqual(110);
        for (const tool of metrics.tools) {
          expect(tool.width).toBeGreaterThan(metrics.width * 0.78);
          expect(tool.label).toBeGreaterThan(10);
        }
      } else if (studio) expect(metrics.width).toBeLessThanOrEqual(70);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath("identity-and-workspace.png") });
      await page.locator("#canvas").focus(); await page.keyboard.press("Control+z");
      await expect.poll(async () => (await recoveredScene(page)).bodies.some((body: { name: string }) => body.name === original)).toBe(true);
      await page.keyboard.press("Control+y");
      await expect.poll(async () => (await recoveredScene(page)).bodies.some((body: { name: string }) => body.name === "Mass <α> 📐")).toBe(true);
      expect(errors).toEqual([]);
    });
  });
}

for (const studio of [false, true]) {
  test.describe(() => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test(`Library description controls stay beneath sticky categories (Studio=${studio})`, async ({ page }, info) => {
      await page.addInitScript(studio => localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, studio_mode: studio })), studio);
      await page.goto("/");
      await page.getByRole("button", { name: "Library", exact: true }).click();
      const library = page.getByRole("dialog", { name: "Library", exact: true });
      const initial = (await library.boundingBox())!;
      await library.getByRole("tab", { name: "My scenes", exact: true }).click();
      expect((await library.boundingBox())!.y).toBeCloseTo(initial.y, 0);
      await library.getByRole("tab", { name: "Examples", exact: true }).click();
      const more = library.locator("button.card-more").first();
      await expect(more).toHaveAccessibleName("Show more");
      await more.click(); await expect(more).toHaveText("Show less");
      await more.click(); await expect(more).toHaveText("Show more");
      const surface = library.locator(".overlay-body");
      await surface.evaluate(el => { el.scrollTop = 400; });
      const result = await library.locator(".cat-chips").evaluate(el => {
        const rect = el.getBoundingClientRect();
        let escaped = 0, samples = 0;
        for (let x = rect.left + 3; x < rect.right - 3; x += 9) for (let y = rect.top + 3; y < rect.bottom - 3; y += 7) {
          samples++;
          if (document.elementFromPoint(x, y)?.closest(".card-more")) escaped++;
        }
        return { escaped, samples, position: getComputedStyle(el).position };
      });
      expect(result.position).toBe("sticky"); expect(result.samples).toBeGreaterThan(0); expect(result.escaped).toBe(0);
      await page.screenshot({ path: info.outputPath("library-sticky-categories.png") });
    });
  });
}

test("each rapid refresh replays the horizontal acknowledgement without a counter or extra action", async ({ page }, info) => {
  await page.addInitScript(() => {
    localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true }));
    const proof = { transforms: [] as string[], sampled: false,
      frames: [] as Array<{ elapsed: number; width: number; clientWidth: number; height: number; clientHeight: number }> };
    (window as unknown as { refreshProof: typeof proof }).refreshProof = proof;
    document.addEventListener("animationstart", event => {
      if (!(event.target instanceof HTMLElement) || !event.target.matches(".toast-refresh")) return;
      proof.transforms = event.target.getAnimations().flatMap(animation =>
        ((animation.effect as KeyframeEffect)?.getKeyframes() ?? []).map(frame => String(frame.transform)));
      const host = event.target.parentElement!, started = performance.now();
      const sample = () => {
        proof.frames.push({ elapsed: performance.now() - started,
          width: host.scrollWidth, clientWidth: host.clientWidth,
          height: host.scrollHeight, clientHeight: host.clientHeight });
        if (performance.now() - started < 350 || proof.frames.length < 3) requestAnimationFrame(sample);
        else proof.sampled = true;
      };
      sample();
    });
  });
  await page.goto("/");
  for (let i = 0; i < 3; i++) {
    await page.reload();
    const toast = page.locator(".toast-refresh"); await expect(toast).toBeVisible();
    await expect(toast.locator(".toast-title")).toHaveText("Page refreshed");
    await expect(toast.locator("button")).toHaveCount(1);
    const appearance = await toast.evaluate(el => ({
      animation: getComputedStyle(el).animationName,
      text: el.textContent,
    }));
    expect(appearance.animation).not.toBe("none");
    await expect.poll(() => page.evaluate(() => {
      const transforms = (window as unknown as { refreshProof: { transforms: string[] } }).refreshProof.transforms;
      const frames = transforms.map(transform => new DOMMatrix(transform));
      return frames.length >= 2 && frames[0].m41 < 0 && frames.at(-1)!.m41 === 0 && frames.every(frame => frame.m42 === 0);
    }))
      .toBe(true);
    expect(appearance.text).not.toMatch(/Start fresh|#\d/);
    await expect.poll(() => page.evaluate(() => (window as unknown as { refreshProof: { sampled: boolean } }).refreshProof.sampled)).toBe(true);
    const frames = await page.evaluate(() => (window as unknown as { refreshProof: {
      frames: Array<{ elapsed: number; width: number; clientWidth: number; height: number; clientHeight: number }>;
    } }).refreshProof.frames);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames.every(frame => frame.clientWidth > 0 && frame.clientHeight > 0 &&
      frame.width <= frame.clientWidth + 1 && frame.height <= frame.clientHeight + 1)).toBe(true);
    await info.attach(`refresh-${i}-geometry`, { body: JSON.stringify(frames), contentType: "application/json" });
  }
  await page.screenshot({ path: info.outputPath("refresh-acknowledgement.png") });
  expect(await page.locator("#toasts").evaluate(el => el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth)).toBe(true);
});
