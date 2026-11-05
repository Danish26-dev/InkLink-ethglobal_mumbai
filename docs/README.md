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

This repo contains the full Inklink system, split across workstreams. **This checkout
focuses on Omkar's two modules** — the native app and the Hedera x402 payment system —
plus the shared contracts and docs the whole team depends on.

```
inklink/
├── src/, index.html, ...    # Cinematic landing page (Vite + React + Three.js) [Danish]
├── apps/
│   └── mobile/              # React Native + Expo (SDK 58) customer app   [Omkar]
├── services/
│   ├── payment-agent/       # Hedera x402 Payment Agent + x402 gate (Node) [Omkar]
│   └── mock-gateway/        # MOCK backend/gateway for dev + reference     [Omkar]
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

Modules owned by the main lead (XYZ) — FastAPI backend, local gateway, Document
Engine, 0G integration, 0G Galileo registry, ESP32 firmware — are not in this checkout yet. They
integrate against the contracts in `packages/shared-schemas` and [`API_CONTRACTS.md`](API_CONTRACTS.md);
`services/mock-gateway` is the reference for how the backend should behave.

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
