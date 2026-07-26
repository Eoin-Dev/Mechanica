import { defineConfig } from "vite";

export default defineConfig({
  // Site is served from a sub-path on GitHub Pages; "./" keeps asset URLs
  // relative so the same build works there, on Cloudflare Pages and locally.
  base: "./",
  // MathLive (the typeset formula editor) is a single ~800 kB lazy chunk;
  // it only loads when a force-field row is opened, so its size is fine.
  build: { target: "es2022", chunkSizeWarningLimit: 900 },
  test: {
    // Vitest stubs CSS imports to empty strings by default, which makes a
    // `?raw` import of the stylesheet unreadable. The focus-ring test needs
    // the real text: the one rule that draws the keyboard ring is a bare
    // `:focus-visible`, so any `outline: none` carrying more specificity
    // deletes it silently, and that has happened once already.
    css: true,
  },
});
