import { defineConfig } from "vite";

export default defineConfig({
  // Site is served from a sub-path on GitHub Pages; "./" keeps asset URLs
  // relative so the same build works there, on Cloudflare Pages and locally.
  base: "./",
  // MathLive (the typeset formula editor) is a single ~800 kB lazy chunk;
  // it only loads when a force-field row is opened, so its size is fine.
  build: { target: "es2022", chunkSizeWarningLimit: 900 },
});
