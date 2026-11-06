# Judge walkthrough and demo scenarios

## Start

```powershell
.\scripts\dev-stack.ps1                      # 0G Private Computer (needs ZEROG_API_KEY, ZEROG_MODEL_ID in services/strands-agent/.env)
.\scripts\dev-stack.ps1 -Provider vertex-ai  # explicit alternative provider
```

The script opens the customer app at http://localhost:5174/ and the shop dashboard at http://localhost:5174/shop, and prints the shop admin token.

## Walkthrough (about 3 minutes)

1. **Customer, no login.** Open http://localhost:5174/ on a phone-sized window. Pick the shop. No account and no wallet are needed.
2. **Upload and instruct.** Attach a PDF, then send: `2 copies, black and white, A4, double-sided`.
3. **Agent Workspace.** Tap *Watch operator*. The operator's cursor opens each printer control and selects the value the tool asked for. Every motion maps to a real event in the stream at the bottom:
   - `tool_started` opens the menu;
   - `configuration_updated` changes the value;
   - `tool_succeeded` shows the check;
   - `tool_failed` shows the real error.
   The left panel shows the provider (0G Private Computer), model and trust mode. The right panel shows the live configuration, the document, printer readiness and the execution gates. *Replay run* replays the same recorded events.
4. **Price.** Back in the chat, tap *Get price*. The price uses the real page count and the shop's per-page rate.
5. **Payment handoff.** *Approve & pay in Inklink app* opens `inklink://pay?handoff=…` or shows a QR for the native app. The browser never takes payment.
6. **Shop.** In `/shop`, check the dark sidebar: availability toggle, agent status and printer status. *Incoming orders* lists each order's gates. *Approve* prints only when every gate is satisfied, and *Mark completed* closes it.

## Repeatable scenarios

| # | Scenario | How | Expected |
|---|---|---|---|
| 1 | Happy configuration | PDF + "2 copies, black and white, A4, double-sided" | all six controls set, validated, execution requested; gates show what is pending |
| 2 | Provider unavailable | start without `ZEROG_*` | banner "Print operator unavailable", `agent_finished: unavailable`, no tool events, no settings changed |
| 3 | Offline printer | ask for a printer that is offline | `check_printer_readiness` fails with `PRINTER_UNAVAILABLE`; the printer is not selected |
| 4 | Change after validation | send "make it 3 copies" | copies change, validation is cleared and re-run, the previous quote is withdrawn |
| 5 | Shop paused | toggle *Accepting orders* off | the shop list shows "Not accepting orders"; new jobs get 503 `SHOP_UNAVAILABLE` |
| 6 | Payments not configured | no payment env | the price is shown with "This shop has not set up payments yet"; no handoff is issued |
| 7 | Reconnect | stop/start the backend while the workspace is open | the stream shows `reconnecting`, then resumes from the last `seq` with no duplicates |

## Known gaps

- The native app does not handle `inklink://pay` or the handoff QR yet.
- DOCX files can be configured and priced, but the printer adapter prints PDF only.
- The quality setting is the driver default; the adapter cannot configure it.
