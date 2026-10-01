import assert from "node:assert/strict";
import { test } from "node:test";
import { percentile, summarizeSample } from "./performance-report.mjs";

function sample() {
  const telemetry = { playing: true, bodies: 2, level: 3, physicsMs: 1.2,
    renderMs: 0.45, contacts: 0, canvasPixels: 921600 };
  return { timestamps: [100, 116, 136, 154], telemetry: [
    { ...telemetry, time: 1 }, { ...telemetry, time: 1.5 },
  ] };
}

test("nearest-rank percentiles sort a copy and handle boundary ranks", () => {
  const values = [40, 10, 30, 20];
  assert.equal(percentile(values, 0.5), 20);
  assert.equal(percentile(values, 0.95), 40);
  assert.equal(percentile(values, 0), 10);
  assert.equal(percentile(values, 1), 40);
  assert.deepEqual(values, [40, 10, 30, 20]);
});

test("measured reports use frame percentiles and actual telemetry", () => {
  assert.deepEqual(summarizeSample("collision", "maximum", 2, sample()), {
    scene: "collision", mode: "maximum", dpr: 2, bodies: 2, adaptiveLevel: 3,
    fps: 55.6, medianFrameMs: 18, p95FrameMs: 20, physicsMs: 1.2, renderMs: 0.45,
    contacts: 0, canvasMegapixels: 0.92,
  });
});

test("reported FPS includes long frames instead of hiding them behind the median", () => {
  const measured = { ...sample(), timestamps: [0, 16, 32, 96] };
  const report = summarizeSample("", "", 1, measured);
  assert.equal(report.fps, 31.3);
  assert.equal(report.medianFrameMs, 16);
  assert.equal(report.p95FrameMs, 64);
});

test("missing, non-finite and negative timing samples fail measurement", () => {
  for (const values of [[], [NaN], [Infinity], [-1]]) {
    assert.throws(() => percentile(values, 0.5), /timing samples/);
  }
  assert.throws(() => summarizeSample("", "", 1, { ...sample(), timestamps: [10, 10, 10] }), /positive/);
  for (const rank of [NaN, -1, 2]) assert.throws(() => percentile([16], rank), /rank/);
});

test("an automatically paused scene cannot be reported as a fast simulation", () => {
  const measured = sample();
  measured.telemetry[1].playing = false;
  assert.throws(() => summarizeSample("", "", 1, measured), /stopped/);
});

test("a stalled clock cannot pass through the benchmark", () => {
  const measured = sample();
  measured.telemetry[1].time = measured.telemetry[0].time;
  assert.throws(() => summarizeSample("", "", 1, measured), /did not advance/);
});

test("missing or poisoned telemetry fails with a useful reason", () => {
  assert.throws(() => summarizeSample("", "", 1, { timestamps: [16], telemetry: [] }), /Missing/);
  for (const key of ["time", "bodies", "level", "physicsMs", "renderMs", "contacts", "canvasPixels"]) {
    const measured = sample();
    measured.telemetry[1][key] = NaN;
    assert.throws(() => summarizeSample("", "", 1, measured), new RegExp(key));
  }
});

test("the first partial frame and absolute clock origin cannot skew FPS", () => {
  const measured = sample();
  const expected = summarizeSample("", "", 1, measured);
  for (const origin of [-100, 90, 1_000_000]) {
    const shifted = { ...measured, timestamps: measured.timestamps.map(time => time + origin) };
    assert.deepEqual(summarizeSample("", "", 1, shifted), expected);
  }
  assert.throws(() => summarizeSample("", "", 1, { ...measured, timestamps: [200, 190] }), /timing samples/);
});
