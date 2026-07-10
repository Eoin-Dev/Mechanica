import { defineConfig } from "vite";

export default defineConfig({
  // Site is served from a sub-path on GitHub Pages; "./" keeps asset URLs
  // relative so the same build works there, on Cloudflare Pages and locally.
  base: "./",
  build: { target: "es2022" },
});
