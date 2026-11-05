# INKLINK — The Digital Atelier

A cinematic, immersive 3D landing page for **INKLINK**, a decentralized, agentic printing and document execution network.

> Your Document. Your Agent. Your Control.

This is not a conventional SaaS page. The entire experience is built around a continuous WebGL environment — a premium printing-and-technology workshop — that the camera travels through as you scroll. Typography, sections, camera movement and 3D objects work together to tell one story:

**Documents → Intelligence → Local Connectivity → Autonomous Payments → Physical Execution.**

## Stack

- **React 18 + TypeScript**
- **Vite** build tooling
- **Three.js** + **React Three Fiber** + **Drei** for the 3D atelier
- **GSAP** for the hero typography reveal
- **Tailwind CSS** for the Swiss/industrial design system
- **lucide-react** icons

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build to /dist
npm run preview  # preview the production build
```

## How it works

### Continuous 3D environment
A single fixed `<Canvas>` (`src/three/Experience.tsx`, code-split) sits between the page background and the content layer. `src/three/world.ts` lays out one continuous atelier: each chapter has a zone along the X axis (`src/three/zones/*`), and the camera flies between them.

### Scroll chapters
Each section is a tall `Chapter` (`src/components/ui.tsx`) whose viewport sticks while the camera performs that chapter. `Scene.tsx` reads which chapter crosses the viewport centre and its local progress every frame, then drives the camera pose, the zone animations and the paper → ink lighting shift. The text sits in a left panel on desktop and a bottom panel on mobile; the camera's view offset keeps the 3D subject in the open part of the screen.

### Visual QA
With the dev server running, `npm run qa` renders every chapter in local Chrome (desktop and mobile), saves screenshots to `qa-shots/` and logs console errors.

### External links
Set `VITE_INKLINK_APP_URL`, `VITE_INKLINK_GITHUB_URL`, `VITE_INKLINK_DISCORD_URL` and `VITE_INKLINK_CONTACT_EMAIL` in `.env.local` to enable those links. Until then, Launch Inklink opens a dialog explaining the development status, and community links show as "soon".

### The printer
`src/three/objects/Printer.tsx` is a fully procedural premium desktop laser printer: matte-black body, paper-white structural components, a breathing signal-orange status indicator, a visible output tray and a sheet that rides out of the output slot during the hero, the "Execute" workflow beat and the final commission.

## Brand identity (locked)

| Colour | HEX | Usage |
| --- | --- | --- |
| Ink Black | `#111111` | Primary text, dark sections |
| Paper White | `#FAFAF7` | Main background |
| Signal Orange | `#F15A36` | CTAs, highlights, key interactions |
| Graphite | `#777777` | Secondary text |
| Light Grey | `#EAEAE7` | Borders, dividers, surfaces |

Distribution is ~65% paper white, ~25% ink black, ~10% signal orange. No other accent colours are introduced.

## Accessibility & performance

- **WebGL fallback**: a React error boundary (`src/three/CanvasBoundary.tsx`) plus a capability check render a static paper-white gradient if WebGL is unavailable or the 3D layer fails. The full page stays usable.
- **Reduced motion**: `prefers-reduced-motion` disables float/parallax/pulse animation and the GSAP hero timeline, and freezes camera parallax.
- **Responsive rendering tiers**: `low` / `mid` / `high` scale DPR, shadows, antialiasing and geometry detail based on device.
- **Keyboard & semantics**: skip link, semantic landmarks, focus-visible styles, accessible buttons, active-section nav indicator.

## Honesty note

INKLINK is under active development. The site communicates the product vision without fabricating metrics, deployments, testimonials or partnerships. Technical distinctions — what works locally vs. what requires connectivity, and that offline authorization is **not** completed on-chain settlement — are preserved throughout.

## Project structure

```
src/
  App.tsx                 # wires scroll, nav, hero reveal, sections
  lib/                    # brand tokens, scroll + environment hooks
  components/             # Logo, Navigation, Preloader, shared UI
  sections/               # Hero, Workshop, Workflow, LocalFirst,
                          # OfflinePay, Technology, Privacy,
                          # Developers, FinalCTA, Footer
  three/
    Experience.tsx        # fixed WebGL layer + fallback
    Scene.tsx             # continuous atelier, lighting, camera driver
    cameraPath.ts         # scroll → camera stations
    materials.ts          # shared, disposable materials
    objects/              # Printer, Phone, Hardware, Document,
                          # Abstract, ConnectionLine
public/
  inklink-logo.svg        # brand symbol
```
