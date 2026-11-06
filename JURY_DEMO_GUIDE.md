# ETHGlobal jury demo guide

Open **http://localhost:5173/portal** (or `/jury` directly) and choose **Explore Inklink**. No account is needed.

The jury demo runs the real application on one job in an isolated demo shop (`shop_demo`):
- Customers never see this shop.
- A judge sees only their own demo jobs.
- **Exit Jury Demo** returns to the portal.
- **Reset demo** deletes only that judge's demo jobs.

Every step is labelled **LIVE**, **SIMULATED**, **NOT CONFIGURED** or **UNAVAILABLE**, based on what the backend reports.

## Stages

1. **Introduction:** what Inklink is, and a live integration status panel. Choose *Start the live demonstration* or *Explore the technical architecture*.
2. **Customer:** the real customer print session.
   - Open the demo shop and upload a PDF from your computer.
   - Enter, for example: `Print this document in A4, black and white, two copies, double-sided.` and press Start.
3. **Live processing:** received → classified → trust mode → 0G inference → Strands → operations → document engine → validation, all from the job record and its events.
   - If the AI operator cannot run (for example, no 0G keys), its real error is shown and you can run the **deterministic demo operator**. Its planning is SIMULATED (fixed rules, no AI), but it calls the same real tools: printer discovery, readiness, validation on the real adapter, and the backend execution request.
4. **Print shop:** the real shop orders table, showing the same job. Approve it as the demo shop. No shopkeeper credentials or private shop data are involved.
5. **Agent Workspace:** the real workspace. Every cursor move is a backend-relayed tool event. *Replay run* replays recorded events and re-executes nothing.
6. **Payment:** INR quote → backend USDC → customer authorization → native-app handoff → x402 challenge → settlement verification.
   - Without a funded Hedera configuration you can record a **SIMULATED settlement**. It never sets the real payment status, and never creates a transaction id, a HashScan link or a signature.
7. **Execution:** the backend checks every gate and validates the configuration on the real printer adapter, then records a **SIMULATED submission**. Nothing is printed. Gateway, adapter, printers and ESP32-S3 are shown exactly as reported (the ESP32-S3 shows *not configured* until a device reports).
8. **Result:** the lifecycle with live/simulated labels, the full event history, and Galileo records queued but not sent.

Switch perspectives at any time with **Customer · Shop · Agent** in the header. The demo job reference is always shown and can be copied.

## Reliability

- The deterministic fallback makes the demo repeatable without any credentials.
- Every service failure shows a message, never a blank screen.
- Verified in a browser: all eight stages on one uploaded PDF, 0 page errors, and 0 calls to the printer's print endpoint.

## Making more of it live

| Make live | Add (see ENVIRONMENT_SETUP.md) |
|---|---|
| AI operator on 0G | `ZERO_G_*_API_KEY` in `services/backend/.env` |
| Real Hedera payment | payment-agent and gate secrets, `MERCHANT_ACCOUNT_ID`, `INR_TO_USDC_RATE`, and the native app handling `inklink://pay` |
| ESP32-S3 status | `DEVICE_TOKEN` plus firmware reporting to `/api/v1/devices/heartbeat` |
| Galileo records | deployed contracts, ABIs and the env described in `SMART_CONTRACT_INTEGRATION.md` |

The demo shop can never print physically, even when everything is configured.
