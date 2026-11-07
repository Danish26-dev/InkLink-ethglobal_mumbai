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
| **Agent discovered the endpoint, read the 402 price, then paid** 0.10 USDC | [`0.0.7162784@1793979232.670687781`](https://hashscan.io/testnet/transaction/0.0.7162784@1793979232.670687781) |
| Its spend-audit entry (HCS topic, sequence #4) | [topic `0.0.11339168`](https://hashscan.io/testnet/topic/0.0.11339168) |
| x402 payment, 0.10 USDC agent → shop (audit entry #1) | [`0.0.7162784@1793967953.517115964`](https://hashscan.io/testnet/transaction/0.0.7162784@1793967953.517115964) |
| Earlier x402 payment, 0.10 USDC | [`0.0.7162784@1793916490.190691897`](https://hashscan.io/testnet/transaction/0.0.7162784@1793916490.190691897) |

All are `SUCCESS` on the mirror node. Asset: HTS USDC `0.0.429274`. Agent wallet
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
npm test                              # 106 tests, no network needed
```

The shop account must also have USDC associated. For a stand-in shop that you control, run
`npm run setup:merchant` (see `docs/ENVIRONMENT.md`).

More detail: `docs/PAYMENT_FLOW.md`, `docs/API_CONTRACTS.md`, `docs/SECURITY.md` and
`docs/INTEGRATION_STATUS.md`.

---

## System architecture

Inklink is not a single cloud app. It joins four parts that can be run and reasoned about separately:

1. **Customer applications.** The React PWA (`apps/web`, no login, no wallet) and the React Native / Expo app (`apps/mobile`, holds the device key and authorizes payment).
2. **AI interpretation and deterministic processing.** The Strands agent (`services/strands-agent`) turns natural language into a structured operation plan. The Python document engine (`services/document-engine`) validates and executes it.
3. **Payment and verification.** The Hedera x402 payment agent (`services/payment-agent`) and the x402 gate. Settlement is only accepted from the agent's HMAC-signed callback, sent after it checks the Hedera mirror node.
4. **Shop infrastructure.** The shop gateway (`services/shop-gateway`), the local printer adapter (`services/local-printer-agent`) and the ESP32-S3 status display.

Workflow:

```
Customer -> shop connection -> document submission -> AI interpretation
 -> deterministic document processing -> DOCUMENT approval
 -> shop quotation -> QUOTE approval -> payment -> settlement verification
 -> shop approval -> local print execution
```

Document approval and quote approval are separate stages. The backend does not move a job to printing until every gate is satisfied (`try_execute` in `services/backend/app/jobs.py`).

**The LLM never edits a document.** The agent only proposes structured operations. The document engine, which is plain Python, validates each operation against an allow-list and applies it. The original file is never changed, and edited copies need the customer's approval.

### What each shop-side component is

| Component | Role | It is not |
|---|---|---|
| Printer | Produces paper. | |
| Local printer adapter (`local-printer-agent`) | Windows spooler adapter on `127.0.0.1:7777`. Discovers printers and submits a validated PDF. | A job queue or history store. |
| Shop gateway (`shop-gateway`) | Outbound-only connector. Long-polls the backend, runs only four allow-listed adapter calls, fetches the PDF through a one-time reference, and reports results. Also serves read-only status on the shop LAN for the display. | A durable queue. It decides nothing about authorization. |
| ESP32-S3 interface | Status display and local interaction for the shop, talking to the backend over authenticated HTTPS (`/api/v1/devices/heartbeat`, `/events`, `/display`). | A PDF renderer, a print gateway, or a payment actor. It never starts or verifies payments. |

### Offline-first: what is implemented and what is not

The intent is to move intelligence toward the physical printer so that printing does not depend on an always-on cloud. This table says how far that has gone today.

| Capability | Status | Evidence / gap |
|---|---|---|
| Shop hardware stays on the shop network; only outbound connections | **Implemented** | `shop-gateway` makes outbound calls only. |
| Backend and printer on the same LAN with no relay (`PRINTER_MODE=direct`) | **Implemented** | `services/backend/app/config.py`. Payment and inference still need internet. |
| Gateway reconnects with backoff after a network error or backend restart | **Implemented** | `gateway.mjs` (1 s to 30 s with jitter). |
| Gateway retries reporting a result a few times | **Partial** | Retries are in memory only. A gateway crash loses an unreported result. |
| Device heartbeat, online/offline detection | **Implemented** | `services/backend/app/devices.py`. |
| Print completion only from a real device `print_completed` event for a job the backend submitted | **Implemented** | `devices.py`. |
| Durable outbox with retry for on-chain audit records | **Implemented (backend)** | `chain.py` queues records and sends them when configured. Today 32 are queued because no contract is deployed. |
| Offline payment promise (OfflinePay voucher) with later settlement | **Implemented (app and backend)** | `apps/mobile/src/offline`, `services/backend/app/offline_pay.py`. A voucher becomes settled only through the signed settlement callback, so it does not bypass payment verification. |
| Local SQLite persistence | **Mobile app only** | `apps/mobile/src/db/database.ts`. The gateway has no SQLite. The backend persists a JSON snapshot. |
| Durable local print queue on the shop machine | **Not implemented** | Planned (Phase 2). |
| Executing a previously authorized job while the internet is down | **Not implemented** | The gateway holds no cached job and no authorization it can verify locally. Printing today needs the backend online. |
| Idempotent two-way sync, conflict handling, crash recovery for jobs | **Not implemented** | Planned (Phase 2). |
| Local document processing without the cloud | **Not implemented** | The document engine runs on Cloud Run. Packaging it for the shop machine is planned. |

**Security rule for any future offline mode.** Offline execution must never bypass payment verification or print authorization. A job may run offline only if the backend has already issued an authorization that the gateway can verify locally, for example an expiring, job-bound token signed with a key whose public half the gateway has pinned, issued only after the settlement callback. The gateway must not treat an arbitrary cached job as authorized. That signed authorization does not exist yet.

**What a sync design would need (not built).** A SQLite job table on the shop machine with a state column, an idempotency key per job and event so replays are harmless, a rule that the backend is the source of truth for authorization while the gateway is the source of truth for physical status, retries with backoff, and replay of unsent `print_started`, `print_completed` and `print_failed` events on reconnect. Treat all of this as design work, not a feature.

### Cloud cannot do without vs. local can do

Cloud-dependent today: AI interpretation on 0G Private Computer, document processing, cross-shop discovery, quotation, Hedera x402 initiation and settlement verification, and the print authorization decision.

Local today: talking to the printer, reporting device status, and a LAN-only deployment of the backend with `PRINTER_MODE=direct`.

---

## Technology: integrated vs. not

Only what the repository actually contains is listed as integrated.

| Area | Integrated | Notes |
|---|---|---|
| Web frontend | React 18, TypeScript, Vite, Tailwind CSS, React Router | `apps/web` |
| Mobile | React Native, Expo (expo-router), TypeScript | `apps/mobile` |
| Backend | Python FastAPI on Google Cloud Run | `services/backend` |
| Node services | Express (payment agent, x402 gate), Node.js (gateway, printer adapter, Strands agent) | |
| AI | Strands Agents SDK, 0G Private Computer, GLM-5.3 (`glm-5.3`) | Trust mode is chosen per document. |
| Document processing | Python engine, python-docx, LibreOffice (DOCX to PDF) | `services/document-engine` |
| Payments | Hedera Testnet, Hedera x402 (`@x402/*`, `@hiero-ledger/sdk`), Blocky402 testnet facilitator, HCS audit topic | Facilitator set by `FACILITATOR_URL`. |
| 0G chain | `InklinkRegistry.sol` (Solidity 0.8.24), Hardhat, ethers.js, eth-account | Tested. **Not deployed yet**; records queue locally. |
| Data | SQLite (mobile app), JSON snapshot on a Cloud Storage volume (backend) | |
| Hardware | Local printer adapter, shop gateway, ESP32-S3 backend endpoints | |

Not integrated, despite appearing in plans:

- **Firestore.** The repository has no Firestore code. Backend state is a JSON snapshot.
- **ESP32-S3 firmware (Arduino, SSD1306 OLED, buttons, LEDs, buzzer).** There is no firmware in this repository. The backend endpoints the device uses are implemented and tested, but the OLED, button, LED and buzzer behaviour is not verified from this source.
- **Local SQLite in the gateway**, **local document processing**, and **offline authorized printing** (see the table above).
- **0G Galileo contract on-chain.** Written and tested, awaiting deployment.

---

## Architecture Roadmap

These are goals, not completed functionality.

### Phase 1: Connected printing infrastructure (current)

- Customer-to-shop workflow with no customer account.
- AI-assisted editing with deterministic execution.
- Separate document approval and quote approval.
- Payment coordination and settlement verification on Hedera.
- Connected shop gateway and printer adapter.
- ESP32 device heartbeat, events and status display endpoints.
- Remaining to finish Phase 1: run the shop gateway against the live backend, deploy the 0G registry contract, and prove one full print on real hardware.

### Phase 2: Offline-first local infrastructure

- Durable SQLite print queue on the shop machine.
- A backend-issued, job-bound, expiring print authorization that the gateway verifies locally, so a paid and approved job can finish during an internet outage.
- Idempotent synchronization of print status, with retries and replay of unsent events after reconnect.
- Safe recovery after a power or network interruption.
- Local document processing where it is technically feasible.
- Better printer integrations beyond the Windows spooler.

### Phase 3: Distributed and decentralized infrastructure

- Reduce dependence on a single hosted backend.
- Independently operated shop gateways.
- Distributed shop discovery.
- Alternative RPC providers for Hedera and 0G reads and writes.
- Independent verification of settlement from public chain data.
- Decentralized coordination and verifiable execution.
- Stronger privacy-preserving computation.

---

## CROPS

Lead property: **Privacy (P)**. Censorship resistance is the weakest property today and is stated as a trade-off.

**C: Censorship resistant.** *Partial, and honest about it.* Users depend on our Cloud Run backend and domain, on one Hedera mirror node and facilitator, and on the 0G router. If our backend goes away the web app stops. A shop can run the whole backend on its own computer (`PRINTER_MODE=direct`), but it still needs 0G inference and Hedera. Independent gateways and alternative RPC providers are Phase 3 goals, not features.

**O: Open source.** *Yes.* MIT licence. The repo contains the web app, mobile app, backend, document engine, agents, payment agent, gateway, printer adapter, deploy scripts and contracts. A user can build and run it from the repo with their own 0G, Hedera and Google Cloud credentials. See `docs/` and `deploy/gcp/README.md`.

**P: Private.** *Lead property.*
- Customers need no account, name or wallet in the browser. Sessions use random tokens.
- The backend classifies each document before any model call. Sensitive or unreadable documents run in `private` mode (TeeML on 0G Private Computer) and are never downgraded. A missing key stops the run instead of falling back.
- The 0G keys, gateway token and device token stay on the server. They are never sent to the browser or the agent.
- The web client has no third-party trackers or analytics.
- What others learn: Google Cloud hosts the backend and sees traffic and stored state; the 0G provider sees prompts in Standard and Verified modes (not in Private); the Hedera ledger and HCS topic are public and show the paying account, merchant, amount and a payment ID, but no document content; the ESP32 receives job status only, never documents, file names, INR prices or customer data.
- Limit: this is not anonymity. A Hedera payer account is public, and the backend sees the document in order to process it.

**S: Secure.**
- Payments are authorized in the mobile app with a device key held in secure storage. The browser never takes payment.
- A job counts as paid only after the payment agent verifies the transaction on the Hedera mirror node and sends an HMAC-signed callback. There is no simulated settlement for real jobs.
- Pairing uses a signed shop QR, a pinned Ed25519 gateway key and a single-use challenge.
- The gateway makes only outbound calls and can run only four allow-listed adapter calls. The PDF is fetched through a one-time reference.
- The payment agent, agent and document engine are private Cloud Run services reachable only with Google ID tokens, and CORS has no wildcard.
- Trust assumptions: our backend and Cloud Run project, the Hedera mirror node, the 0G provider's TEE attestation (a provider-level attestation, not a per-response signature check), and a shared gateway token and device token (per-device tokens are not built).
