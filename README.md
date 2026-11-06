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

---

## Hedera x402: the payment agent that pays for print jobs

*Owner: Omkar. Code: `services/payment-agent`, `packages/shared-schemas`, `apps/mobile`.*

An AI payment agent pays the print shop **itself**, inside an ordinary HTTP request. The shop's
endpoint answers **HTTP 402 Payment Required** with an x402 price. The agent checks it against the
customer's budget, signs, and settles **USDC on Hedera testnet** through the **Blocky402**
facilitator, which pays the network fee. There is no checkout page, no signup and no API key.

### Proof (real Hedera testnet transactions)

| What | Hedera reference |
|---|---|
| x402 payment, 0.10 USDC agent → shop | [`0.0.7162784@1793967953.517115964`](https://hashscan.io/testnet/transaction/0.0.7162784@1793967953.517115964) |
| Its spend-audit entry (HCS topic, sequence #1) | [topic `0.0.11339168`](https://hashscan.io/testnet/topic/0.0.11339168) |
| Earlier x402 payment, 0.10 USDC | [`0.0.7162784@1793916490.190691897`](https://hashscan.io/testnet/transaction/0.0.7162784@1793916490.190691897) |

All three are `SUCCESS` on the mirror node. Asset: HTS USDC `0.0.429274`. Agent wallet
`0.0.11330279`, shop wallet `0.0.11227614`, facilitator fee payer `0.0.7162784`. These runs used
`npm run demo:pay` with a dev device key, a fixed 0.10 USDC price and a stand-in shop account; the
same agent code is what the Inklink backend calls in the full flow.

### Architecture

```text
Phone app ──signed budget──▶ Inklink backend ──bearer token──▶ Payment agent ──x402──▶ x402 gate
 (device key)                (owns quote + amount)            (spend policy,        (HTTP 402,
                                                                signs USDC)          per-job price)
                                   ▲                              │                      │
                                   │  HMAC-signed callback        │ Blocky402 settles    │
                                   └──────────────────────────────┤ on Hedera testnet ◀──┘
                                                                  ├──▶ Mirror node: verify transfer
                                                                  └──▶ HCS topic: spend audit entry
```

- **Payment agent** (`services/payment-agent/src/server.ts`): internal service. It holds the only
  wallet key (in `signing/signing-service.ts`; never sent to the app or an LLM).
- **x402 gate** (`src/gate-server.ts`, `src/x402-gate.ts`): `POST /api/v1/jobs/{jobId}/execute`
  answers 402 with the job's price, asked from the backend per job.
- **Official x402 packages**: `@x402/core`, `@x402/fetch`, `@x402/express` and `@x402/hedera`.

### Payment flow (no human approves the payment)

1. The customer approves a **budget** once in the app: a per-payment maximum, a total limit, one
   shop and an expiry. The phone signs it with its Ed25519 device key.
2. The backend asks the agent to pay for one job, with the backend-quoted USDC amount.
3. The agent calls the shop's x402 endpoint and gets **402** with the price, pay-to account and
   asset.
4. The agent checks everything: the signed budget, the shop allowlist, the per-payment and total
   limits, the quote expiry, and that the 402 price is **exactly** the quoted amount, pay-to
   account and asset. It reserves the amount, then signs.
5. Blocky402 settles the USDC transfer on Hedera, and the agent gets the paid response.
6. The agent **verifies the transfer on the Hedera mirror node**: right token, right account,
   right amount.
7. The agent writes a **spend-audit entry to HCS** and sends an HMAC-signed callback to the
   backend. The job moves to `awaiting_execution`; a payment never marks a print as completed.

### Spending controls

- A budget that the customer signs on the device (Ed25519), so it can't be forged or replayed.
- A per-payment maximum and a total limit, reserved before signing, so parallel payments can't overspend.
- A shop allowlist, plus an allowlist of x402 endpoints the agent may pay.
- An exact-match rule: the agent refuses any 402 that differs from the quoted amount, shop account
  or asset. Live proof: `npm run demo:pay -- --negative`. The gate charged 0.10, the agent was told
  0.11, it refused to sign, and nothing moved.
- Spend limits and nonces survive restarts, which are saved before each change.
- The agent refuses to run if its wallet and the shop wallet are the same account.

### Tamper-evident spend log (HCS)

After every verified payment, the agent appends one message to its HCS topic
[`0.0.11339168`](https://hashscan.io/testnet/topic/0.0.11339168).

- **Only the agent can append.** The topic's submit key is the agent's key.
- **No one can change or delete it.** The topic has no admin key.
- **Each entry contains** the tx ID, amount, shop and budget state after the payment
  (`spentToDate` / `totalSpendingLimit`).
- **No customer data.** Jobs and budgets appear only as SHA-256 commitments.

### Setup and reproduce

Needs Node 20+ and a Hedera testnet ECDSA account (free at https://portal.hedera.com/).

```bash
cd packages/shared-schemas && npm install && npm run build
cd ../../services/payment-agent && npm install
cp .env.example .env                  # fill in the agent account, key and shop account
npm run setup:wallet -- --associate   # associate USDC with the agent wallet
# get test USDC for the agent at https://faucet.circle.com/ (Hedera Testnet)
npm run setup:wallet                  # until it says "Ready"
npm run setup:audit-topic             # once; put the printed id in HCS_AUDIT_TOPIC_ID
npm run demo:pay                      # real x402 payment; prints the HashScan links
npm run demo:pay -- --negative        # the agent refuses an amount that does not match
npm test                              # 92 tests, no network needed
```

The shop account must also have USDC associated. For a stand-in shop that you control, run
`npm run setup:merchant` (see `docs/ENVIRONMENT.md`).

More detail: `docs/PAYMENT_FLOW.md`, `docs/API_CONTRACTS.md`, `docs/SECURITY.md` and
`docs/INTEGRATION_STATUS.md`.
