# Inklink: native app, payments and services

> The repository root `README.md` describes the cinematic landing page. This document covers the
> monorepo folders `apps/`, `services/`, `packages/` and `docs/`.

**Your Document. Your Agent. Your Control.**

Inklink is a decentralized, agentic printing network that connects customers with
independent print shops through local-first infrastructure, privacy-aware AI, and
autonomous payments.

Built for **ETHGlobal Mumbai** (Nov 5–7, 2026).

> **Core principle:** Basic printing must work without depending on centralized cloud
> infrastructure, 0G Private Computer, blockchain connectivity, or remote AI inference.
> Hedera and 0G provide optional advanced capabilities.

---

## This repository

This repo contains the full Inklink system, split across workstreams. Omkar's modules are the native app (`apps/mobile`) and the Hedera x402 payment system (`services/payment-agent`, plus the mock gateway used as a dev reference). The main lead's (XYZ) modules sit in the same repository; the folder map below lists them.

```
inklink/
├── src/, index.html, ...    # Cinematic landing page (Vite + React + Three.js) [Danish]
├── apps/
│   ├── mobile/              # React Native + Expo (SDK 58) customer app   [Omkar]
│   └── web/                   # customer web app, shop dashboard, jury page [XYZ]
├── services/
│   ├── payment-agent/       # Hedera x402 Payment Agent + x402 gate (Node) [Omkar]
│   ├── mock-gateway/        # MOCK backend/gateway for dev + reference     [Omkar]
│   ├── backend/               # FastAPI backend (quotes, sessions, jobs, OfflinePay ledger) [XYZ]
│   ├── shop-gateway/          # shop computer connector to the printer adapter [XYZ]
│   ├── local-printer-agent/   # printer adapter on the shop computer [XYZ]
│   ├── document-engine/       # document processing [XYZ]
│   └── strands-agent/         # print operator agent [XYZ]
├── packages/
│   └── shared-schemas/      # TypeScript types for API Contracts 1–8      [shared]
├── docs/
│   ├── README.md            # this file
│   ├── ARCHITECTURE.md
│   ├── API_CONTRACTS.md
│   ├── PAYMENT_FLOW.md
│   ├── SECURITY.md
│   ├── ENVIRONMENT.md
│   ├── TESTING.md
│   ├── INTEGRATION_GUIDE.md
│   └── INTEGRATION_STATUS.md
├── LICENSE                  # MIT
└── README.md
```

The main lead's (XYZ) modules (FastAPI backend, shop gateway, printer adapter, document engine, print operator agent, web app, deployment scripts, contracts) are in this repository and are described in their own folders and docs. They integrate with Omkar's modules through the contracts in `packages/shared-schemas` and [`API_CONTRACTS.md`](API_CONTRACTS.md). `services/mock-gateway` remains the executable reference and the offline dev stack.

## Team

| Member | Role | Telegram | X |
| ------ | ---- | -------- | - |
| Omkar  | Native app + Hedera x402 | _TBD_ | _TBD_ |
| XYZ    | Main lead: backend, AI, document engine, 0G, hardware, contracts | _TBD_ | _TBD_ |

## Quick start

See [`ENVIRONMENT.md`](ENVIRONMENT.md) for prerequisites and setup, and
[`TESTING.md`](TESTING.md) for how to run each module independently. Run the commands below from
the repository root.

```bash
# Shared types (build after changing them)
cd packages/shared-schemas && npm install && npm run build

# Mock backend + shop gateway (prints a QR for the app to scan)
cd services/mock-gateway && npm install && npm start

# x402 gate and Payment Agent (internal services; need the env in ENVIRONMENT.md)
cd services/payment-agent && npm install && npm run gate
cd services/payment-agent && npm start

# Mobile app (Expo Go, SDK 58)
cd apps/mobile && npm install && npx expo start --lan
```

The app talks only to the backend; the backend calls the payment agent. See [`PAYMENT_FLOW.md`](PAYMENT_FLOW.md).

## Status

Implementation status is tracked honestly in [`INTEGRATION_STATUS.md`](INTEGRATION_STATUS.md). Mocks
and planned features are clearly labelled there and in code. Nothing fakes a blockchain settlement.

## License

MIT — see [`../LICENSE`](../LICENSE).
