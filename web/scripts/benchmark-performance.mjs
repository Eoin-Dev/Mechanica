import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { summarizeSample } from "./performance-report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const quick = process.argv.includes("--quick");
const warmupMs = quick ? 700 : 1500;
const sampleMs = quick ? 1200 : 3000;
const dprs = quick ? [1] : [1, 2];
const scenarios = quick ? [
  ["empty", "empty"],
  ["two-body collision", "simple"],
  ["gas 200", "gas", 200],
] : [
  ["empty", "empty"],
  ["two-body collision", "simple"],
  ["friction ramp", "preset", "Friction ramp"],
  ["resting/impact stack", "preset", "Wrecking ball"],
  ["gas 50", "gas", 50],
  ["gas 200", "gas", 200],
  ["gas 500", "gas", 500],
  ["gas 1000", "gas", 1000],
  ["gas 2000", "gas", 2000],
  ["spring lattice", "preset", "Jelly block"],
  ["rope", "preset", "Swinging rope"],
  ["mutual gravity", "preset", "Orbit dance"],
];

const server = await createServer({
  root,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: 4174, strictPort: true, watch: null, hmr: false },
});
let browser;
let failure = null;
let activeCase = null;
const results = [];
const expected = dprs.length * scenarios.length * 2;

try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  for (const dpr of dprs) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: dpr,
    });
    await context.addInitScript(() => {
      localStorage.setItem("mechanica.settings", JSON.stringify({
        tour_done: true,
        inspector_visible: false,
        cull: false,
      }));
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto("http://127.0.0.1:4174/", { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__mechanica?.benchmark !== undefined);

    for (const [scene, kind, arg] of scenarios) {
      for (const mode of ["normal", "maximum"]) {
        activeCase = { scene, mode, dpr };
        await page.evaluate(({ kind: loader, arg: value, mode: selected }) => {
          const { app, benchmark } = window.__mechanica;
          if (app.playing) app.togglePlay();
          if (loader === "empty") benchmark.loadEmpty();
          else if (loader === "simple") benchmark.loadSimpleCollision();
          else if (loader === "gas") benchmark.loadGas(value);
          else benchmark.loadPreset(value);
          app.setPerfMode(selected === "maximum");
          if (selected === "maximum") benchmark.forcePerformanceLevel(3);
          if (!app.playing) app.togglePlay();
        }, { kind, arg, mode });
        await page.waitForTimeout(warmupMs);
        const sample = await page.evaluate(async (durationMs) => {
          const timestamps = [];
          const telemetry = [];
          const started = performance.now();
          let lastTelemetry = -Infinity;
          await new Promise((resolve) => {
            const frame = (now) => {
              timestamps.push(now);
              if (now - lastTelemetry >= 200) {
                const { app, benchmark } = window.__mechanica;
                telemetry.push({ ...benchmark.snapshot(), playing: app.playing, time: app.world.time });
                lastTelemetry = now;
              }
              if (now - started >= durationMs) resolve();
              else requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
          });
          return { timestamps, telemetry };
        }, sampleMs);
        if (pageErrors.length) throw new Error(`Browser error: ${pageErrors.join("; ")}`);
        const result = summarizeSample(scene, mode, dpr, sample);
        results.push(result);
        console.error(`[${results.length}/${expected}] ${scene}, ${mode}, DPR ${dpr}: ${result.fps} FPS`);
      }
    }
    await context.close();
  }
} catch (error) {
  failure = error;
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled([browser?.close(), server.close()]);
  for (const result of cleanup) {
    if (result.status === "rejected") {
      failure ??= result.reason;
      process.exitCode = 1;
    }
  }
}

console.table(results);
console.log(JSON.stringify({
  complete: failure === null && results.length === expected,
  error: failure?.message ?? null,
  failedCase: failure === null ? null : activeCase,
  environment: {
    browser: "bundled Chromium",
    browserVersion: browser?.version() ?? null,
    nodeVersion: process.version,
    viewport: "1280x720",
    warmupMs,
    sampleMs,
    generatedAt: new Date().toISOString(),
  },
  results,
}, null, 2));
if (failure !== null) console.error(failure);
