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

**Paid from the phone, nothing mocked.** The Inklink Android app on a real device: scan the shop
QR, pick the job, approve a budget, pay. End to end through the deployed Cloud Run backend, payment
agent and x402 gate:

| What | Hedera reference |
|---|---|
| **Print job paid from the phone app**: paired with the device key, device-signed budget, agent discovered the endpoint, read the 402 price, paid 0.024 USDC, verified on the mirror node | [`0.0.7162784@1794008216.704679762`](https://hashscan.io/testnet/transaction/0.0.7162784-1794008216-704679762) (payment `payment_831523d3`, HCS entry #9) |

**Full cloud flow driven headlessly** (the app's own API client and device-key signing, against the
same deployed services):

| What | Hedera reference |
|---|---|
| Print job paid end to end: backend quote (2.00 INR = 0.024 USDC), device-signed budget, endpoint discovery, 402 price read, paid, verified, signed callback delivered | [`0.0.7162784@1793992647.222766103`](https://hashscan.io/testnet/transaction/0.0.7162784-1793992647-222766103) (job `job_382a9a8becee`, HCS entry #7) |
| First cloud payment, same flow | [`0.0.7162784@1793986272.588926799`](https://hashscan.io/testnet/transaction/0.0.7162784-1793986272-588926799) (job `job_1b50094f0bb9`, HCS entry #5) |

**Agent runs** (`npm run demo:pay`: dev device key, fixed 0.10 USDC price, stand-in shop account):

| What | Hedera reference |
|---|---|
| Agent discovered the endpoint, read the 402 price, then paid 0.10 USDC (HCS entry #4) | [`0.0.7162784@1793979232.670687781`](https://hashscan.io/testnet/transaction/0.0.7162784-1793979232-670687781) |
| Payment after the concurrency fixes (HCS entry #6) | [`0.0.7162784@1793990131.418337454`](https://hashscan.io/testnet/transaction/0.0.7162784-1793990131-418337454) |
| x402 payment, 0.10 USDC agent → shop (HCS entry #1) | [`0.0.7162784@1793967953.517115964`](https://hashscan.io/testnet/transaction/0.0.7162784-1793967953-517115964) |
| First x402 payment, 0.10 USDC | [`0.0.7162784@1793916490.190691897`](https://hashscan.io/testnet/transaction/0.0.7162784-1793916490-190691897) |
| Spend-audit log (every entry above) | [topic `0.0.11339168`](https://hashscan.io/testnet/topic/0.0.11339168) |

All are `SUCCESS` on the mirror node. Asset: HTS USDC `0.0.429274`. Agent wallet
`0.0.11330279`, shop wallet `0.0.11227614`, facilitator fee payer `0.0.7162784` (Blocky402).
Anyone can check a payment: `curl https://testnet.mirrornode.hedera.com/api/v1/transactions/<tx id with dashes>`
shows the exact USDC transfer, and the HCS topic shows the matching audit entry.

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
  answers 402 with the job's price, asked from the backend per job. `GET /discovery/resources`
  publishes the endpoint as an x402 Bazaar resource list. The 402 itself also carries the
  official Bazaar extension, which describes how to call the endpoint.
- **Official x402 packages**: `@x402/core`, `@x402/fetch`, `@x402/express`, `@x402/hedera` and
  `@x402/extensions` (Bazaar).

### Payment flow (no human approves the payment)

1. The customer approves a **budget** once in the app: a per-payment maximum, a total limit, one
   shop and an expiry. The phone signs it with its Ed25519 device key.
2. The backend asks the agent to pay for one job, with the backend-quoted USDC amount.
3. **The agent finds the paid endpoint itself.** It reads the gate's x402 discovery document
   (`/discovery/resources`, Bazaar format) and builds the job's URL from the listed route.
   Then it calls the endpoint without paying and **reads the price from the 402**: amount,
   pay-to account and asset.
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
- A per-payment maximum and a total limit, checked and reserved in one step with no wait in
  between, so two payments at the same time can't together exceed the limit, and a retried request
  returns the same payment instead of paying twice (tests in `test/payment-races.test.ts`).
- Once a transfer has been signed, any later error keeps the spend reserved and marks that funds
  may have moved. The budget is only freed when nothing was signed or the facilitator refused.
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

### OfflinePay: pay later with a signed promise

When the shop can't settle right away, the customer taps **Pay later (OfflinePay)** in the app.
The phone signs a voucher with its device key: a promise to pay exactly this job's backend-quoted
USDC amount, to this shop, valid 30 minutes. It is **not a payment** until it settles.

- **Limits enforced on the phone, the backend and the agent:** 2.00 USDC per promise, 5.00
  unsettled per device across all shops, one promise per job, no replay.
- **Settled through the same x402 path:** the backend asks the agent to settle
  (`POST /api/v1/offline-payments/settle`). The agent checks the voucher again, reads the 402
  price, pays through Blocky402 and verifies on the mirror node.
- **"Paid" only when verified:** the app shows "Paid on Hedera" only after the backend reports a
  mirror-node verified transaction. If the outcome is unknown, it shows "settling" and nobody
  retries, so it is never charged twice.

Code: `packages/shared-schemas/src/offline-pay.ts`, `apps/mobile/app/offline-pay.tsx`,
`services/payment-agent/src/offline-settlement.ts`, backend `services/backend/app/offline_pay.py`.
**Proven live on the cloud:** a device-signed voucher for 0.024 USDC was accepted by the backend,
settled through the agent and verified on Hedera —
[`0.0.7162784@1794005690.930989293`](https://hashscan.io/testnet/transaction/0.0.7162784-1794005690-930989293)
(voucher payment `offpay_3a836e38e098d2220ea48a68`, HCS entry #8). Resending the identical voucher
returned `duplicate` with no second payment.

### Built on Hedera's x402 standard

| Hedera x402 docs | Inklink |
|---|---|
| Exact scheme, `x402Version: 2`, `hedera:testnet` | Same. The agent refuses any other scheme, version or network |
| Amounts in the token's smallest unit | USDC in 6-decimal units, compared as exact integers |
| The facilitator is the fee payer and submits a partially signed `TransferTransaction` | Official `@x402/hedera` scheme; Blocky402 fee payer `0.0.7162784` (checked on `/supported` before paying) |
| The client account must hold and be associated with the token | `npm run setup:wallet -- --associate` |
| payTo aliases can trigger auto account creation | We always pay a plain account ID, so this never happens |
| No native privacy on the ledger | HCS audit entries contain only SHA-256 commitments, never documents or personal data |

**Known tradeoff:** we use one facilitator, Blocky402, with no fallback (a team decision for a
predictable demo). Hedera's docs list relying on few facilitators as a risk; the official
`x402.org` facilitator and Launa also support `hedera:testnet`, so adding a fallback is a
contained change in `src/facilitator.ts`.

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
npm test                              # 114 tests, no network needed
```

The shop account must also have USDC associated. For a stand-in shop that you control, run
`npm run setup:merchant` (see `docs/ENVIRONMENT.md`).

More detail: `docs/PAYMENT_FLOW.md`, `docs/API_CONTRACTS.md`, `docs/SECURITY.md` and
`docs/INTEGRATION_STATUS.md`.
