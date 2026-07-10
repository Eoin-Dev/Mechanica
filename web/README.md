# Mechanica — Web

The Mechanica physics lab as a static web app: TypeScript, no framework, no
runtime dependencies, no server. The physics engine (Velocity Verlet /
Symplectic Euler / RK4 integrators, two-phase rod constraint solve,
warm-started sequential impulses, spatial-hash broadphase) is verified by an
analytic test suite.

> Historical note: this began as a line-faithful port of a Python/pygame
> desktop app (see git history before mid-2026). The scene `.json` format is
> unchanged, so scenes saved by the old desktop version still import here.

## Develop

```
cd web
npm install
npm run dev        # dev server at http://localhost:5173
npm test           # physics verification suite (42 analytic checks)
npm run build      # production build into dist/
npm run preview    # serve the production build locally
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

## Architecture

- `src/core/` — vector maths and the force-field expression compiler
  (a real tokenizer/recursive-descent parser producing a closure tree —
  no `eval`, works under any Content-Security-Policy).
- `src/engine/` — bodies, walls, links, contacts, and the world stepper.
  Pure TypeScript, fully headless (the test suite runs it under Node).
- `src/scene/` — the 47 built-in presets, scene serialization, undo/redo,
  localStorage saves and `.json` import/export.
- `src/render/` — camera and Canvas-2D scene rendering.
- `src/interact/` — canvas tools: select/drag/throw, wall drawing, link
  creation, box select, pinch-zoom.
- `src/ui/` — DOM chrome: toolbar, tool palette, inspector, graph dock,
  library and help overlays, live plots.
- `tests/` — the physics verification suite: projectile SUVAT, orbit energy
  conservation, pendulum periods, the (2/3)v₀ rolling result, soft-body
  coherence, slingshot flyby, sandbox security, serialization round-trips.
