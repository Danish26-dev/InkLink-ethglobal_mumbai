# Inklink shop gateway connector

Runs on the shop computer next to the local printer adapter. It connects a cloud-hosted Inklink
backend (`PRINTER_MODE=relay`) to the printer with **outbound HTTPS only**, and serves a read-only
status endpoint for the ESP32-S3 display. Node 22+, no dependencies.

```bash
cp .env.example .env    # BACKEND_URL, GATEWAY_TOKEN, PRINTER_AGENT_TOKEN
npm start
npm test
```

Setup, security model and troubleshooting: [HARDWARE_GATEWAY_SETUP.md](../../HARDWARE_GATEWAY_SETUP.md).
Backend side of the protocol: `services/backend/app/gateway_relay.py`.
