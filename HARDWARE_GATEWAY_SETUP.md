# Shop hardware with a cloud backend: printer adapter, gateway connector, ESP32-S3

When the backend runs on Cloud Run, the shop's hardware stays on the shop network and is **never
exposed to the internet**. Everything on the shop side makes outbound HTTPS connections only; no
port forwarding, no public IP, no inbound firewall rule.

```
 shop computer (Windows)                                       Cloud Run
 ┌──────────────────────────────────────────────┐
 │ local printer adapter   127.0.0.1:7777       │
 │   (services/local-printer-agent)             │
 │            ▲ loopback, x-printer-agent-token │
 │ shop gateway connector  (services/shop-gateway)──HTTPS long-poll──▶ inklink-backend
 │            │ GET /display (loopback or LAN)  │                     /api/v1/gateway/*
 └────────────┼─────────────────────────────────┘
              ▼
       ESP32-S3 status display ──HTTPS (DEVICE_TOKEN)──▶ inklink-backend /api/v1/devices/*
```

## 1. Printer adapter (unchanged)

```powershell
cd services\local-printer-agent
npm ci
copy .env.example .env      # PRINTER_AGENT_HOST=127.0.0.1 (keep), set a PRINTER_AGENT_TOKEN
npm start
```

It discovers printers, validates settings and spools approved PDFs. Keep it on loopback.

## 2. Shop gateway connector

Node 22+, no dependencies.

```powershell
cd services\shop-gateway
copy .env.example .env
# BACKEND_URL         = https://inklink-backend-765131918851.asia-south1.run.app
# GATEWAY_TOKEN       = gcloud secrets versions access latest --secret=GATEWAY_TOKEN --project=inklink-513817
# PRINTER_AGENT_TOKEN = the adapter's token from step 1
npm start
npm test                    # 7 tests, no network
```

What it does:

- Long-polls `POST /api/v1/gateway/poll` (≤ 25 s per round) and reconnects with exponential backoff
  and jitter (1 s → 30 s) after any network error or backend restart.
- Executes only `GET /printers`, `GET /printers/{id}/availability`, `POST /validate`, `POST /print`
  against the local adapter. Everything else is answered `403` without touching the adapter.
- For a print, downloads the PDF from the backend's one-time reference (path must be
  `/api/v1/gateway/documents/<token>`, so it can't be pointed at another host), base64-encodes it
  for the adapter, and keeps nothing on disk.
- Refuses a non-https `BACKEND_URL` unless it is loopback (or `ALLOW_INSECURE_BACKEND=1` on a LAN
  test backend).
- Verify: the backend's `/health` shows `"printer":{"mode":"relay","connected":true,…}` and the shop
  dashboard lists the discovered printers.

Run it as a service so it starts with Windows, e.g. with Task Scheduler (*At startup*, *Run whether
user is logged on or not*, action `node.exe --env-file=.env src\index.mjs` in `services\shop-gateway`).

## 3. ESP32-S3 status display

Two independent paths, both outbound from the device's point of view:

1. **Device reporting (to the cloud backend)**: the device sends heartbeats and print events
   directly to the backend over HTTPS with `Authorization: Bearer <DEVICE_TOKEN>`:
   - `POST /api/v1/devices/heartbeat` `{deviceId, shopId, type:"esp32-s3", firmware, state, printerId?, detail?}`
   - `POST /api/v1/devices/events` `{deviceId, jobId, type: print_started|print_completed|print_failed|paper_out|jam|door_open}`

   Read the token with `gcloud secrets versions access latest --secret=DEVICE_TOKEN --project=inklink-513817`.
   A job becomes `completed` only from a real `print_completed` for a job the backend submitted.
2. **Status for the display (from the shop gateway)**: `GET http://<shop-computer>:7780/display`
   returns `{gatewayId, backendConnected, lastPollAt, jobs:[{jobId, status, paymentStatus, deviceStatus, updatedAt, payment?}]}`
   (the last 10 real jobs; never documents or customer data).
   `payment` = `{paymentId, status, verified, amount, asset, network, transactionId, settledAt, verifiedAt, hashscanUrl}`
   appears once a payment exists. `status` is the backend's payment status (`processing`, `settled`,
   `failed`, `expired`). `amount`/`asset`/`network` are the backend's quote. `verified` is `true` and the
   transaction fields are filled **only** after the backend verified the HMAC-signed settlement callback
   that the payment agent sends after its mirror-node check; otherwise they are `null`. Failures and
   expiries are found by the backend's reconciler every 15 s, even when no app is open.
   `authorized: true` appears when the backend authorized print execution. The display never talks to
   the payment agent and never decides anything itself. It binds to
   `127.0.0.1` by default. To let the ESP32 read it over Wi-Fi, set `DISPLAY_HOST` to the shop
   computer's LAN address **and** `DISPLAY_TOKEN`; the device then sends `Authorization: Bearer <DISPLAY_TOKEN>`.
   Never port-forward it.

The ESP32-S3 firmware is not in this repository; the endpoints above are the contract it must
implement. Without a device, the backend reports the ESP32 as *not configured* / *never seen*
honestly, and the jury demo never claims a physical print.

## LAN-only shops (no cloud)

Nothing changes: run the backend on the shop computer with `PRINTER_MODE=direct` (default) and
`PRINTER_AGENT_URL=http://127.0.0.1:7777`. The connector is not needed.

## Troubleshooting

| Symptom | Check |
|---|---|
| `connected:false` in `/health` | connector running? `BACKEND_URL` exact? its log shows `GATEWAY_TOKEN was rejected` on a wrong token |
| printers "unavailable" with relay connected | adapter running on `127.0.0.1:7777`, connector `PRINTER_AGENT_TOKEN` equals the adapter's |
| `PRINTER_RELAY_TIMEOUT` | connector stalled or the adapter takes > 20 s; see both logs |
| ESP32 shows *never seen* | `DEVICE_TOKEN` on the device equals the secret; `shopId` exists |
