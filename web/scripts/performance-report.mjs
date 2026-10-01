/** Nearest-rank statistics for measured samples; never fabricate empty results. */
export function percentile(values, fraction) {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error("Invalid percentile rank");
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error("Missing or invalid timing samples");
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

export function summarizeSample(scene, mode, dpr, sample) {
  const latest = sample.telemetry.at(-1);
  if (!latest || sample.telemetry.length < 2) throw new Error("Missing simulation telemetry");
  for (const entry of sample.telemetry) {
    if (entry.playing !== true) throw new Error("Simulation stopped during measurement");
    for (const key of ["time", "bodies", "level", "physicsMs", "renderMs", "contacts", "canvasPixels"]) {
      if (!Number.isFinite(entry[key]) || entry[key] < 0) {
        throw new Error(`Invalid simulation telemetry: ${key}`);
      }
    }
  }
  if (latest.time <= sample.telemetry[0].time) throw new Error("Simulation did not advance");
  // rAF timestamps belong to frame boundaries, while evaluate() can start
  // partway through a frame. Measure only complete successive intervals.
  const frames = sample.timestamps.slice(1).map((now, index) => now - sample.timestamps[index]);
  const medianFrame = percentile(frames, 0.5);
  if (frames.some(frame => frame <= 0)) throw new Error("Frame duration must be positive");
  const elapsed = sample.timestamps.at(-1) - sample.timestamps[0];
  return {
    scene, mode, dpr,
    bodies: latest.bodies,
    adaptiveLevel: latest.level,
    fps: Number((1000 * frames.length / elapsed).toFixed(1)),
    medianFrameMs: Number(medianFrame.toFixed(2)),
    p95FrameMs: Number(percentile(frames, 0.95).toFixed(2)),
    physicsMs: Number(percentile(sample.telemetry.map(entry => entry.physicsMs), 0.5).toFixed(2)),
    renderMs: Number(percentile(sample.telemetry.map(entry => entry.renderMs), 0.5).toFixed(2)),
    contacts: latest.contacts,
    canvasMegapixels: Number((latest.canvasPixels / 1_000_000).toFixed(2)),
  };
}
