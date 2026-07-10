# Mechanica — Web

The browser version of Mechanica, a full TypeScript port of the Python/pygame
desktop app in the repository root. The physics engine is a line-faithful
translation (Velocity Verlet / Symplectic Euler / RK4 integrators, two-phase
rod constraint solve, warm-started sequential impulses, spatial-hash
broadphase), verified by the same analytic test suite. Scene JSON files are
byte-compatible with the desktop app in both directions.

## Develop

```
cd web
npm install
npm run dev        # dev server at http://localhost:5173
npm test           # physics verification suite (41 analytic checks)
npm run build      # production build into dist/
```

## Deploy — one-time setup

The site is static: no server, no database, effectively unlimited visitors
for free. A GitHub Actions workflow (`.github/workflows/deploy.yml`) already
builds, tests and publishes on every push to `main`.

1. Push this repository to GitHub.
2. In the repo: **Settings → Pages → Build and deployment → Source** and
   choose **GitHub Actions**.
3. Push to `main` (or run the workflow manually from the Actions tab).
   The site appears at `https://<your-username>.github.io/<repo-name>/`.

Alternative hosts (same `web/dist` output, also free): Cloudflare Pages or
Netlify — connect the repo, set the build command to
`cd web && npm ci && npm run build` and the output directory to `web/dist`.

A custom domain can be pointed at any of these from the host's dashboard.

## What differs from the desktop app

- **UI chrome is real HTML/CSS** (toolbar, inspector, library, help),
  which brings text selection, native scrolling, tooltips and mobile
  layout for free. The simulation canvas and live plots stay canvas-drawn.
- **Touch support**: one finger drives the active tool, two fingers
  pinch-zoom and pan.
- **Scenes** save to browser localStorage (Ctrl+S), and can be exported /
  imported as the same `.json` files the desktop app reads and writes.
- **The expression sandbox was redesigned**: user force-field formulas are
  parsed by a real tokenizer/recursive-descent parser into a closure tree —
  no `eval`, works under any Content-Security-Policy. Same language,
  including `^` for power and Python-style `a if cond else b`.
- **One physics code path**: the desktop app's numpy fast path is
  unnecessary — JIT-compiled loops fill that role, and the whole suite of
  soft-body scenes runs several times faster than real time.
- The randomized scenes (gas boxes, billiards, Brownian motion) use a
  different seeded RNG, so their layouts differ from the desktop app in
  detail while remaining reproducible run-to-run.
