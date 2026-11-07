# Inklink — Payment Flow (Hedera x402)

App → Inklink backend → Payment Agent → x402 gate → Blocky402 → Hedera Testnet (HTS-USDC).
Facilitator is fixed: Blocky402. **There is no fallback** to another facilitator, network or
asset; if it is unavailable the payment fails with `FACILITATOR_UNAVAILABLE`.

## Who does what

| Actor | Owns |
|-------|------|
| App (Omkar) | Shows the quote and USDC amount (display only), collects explicit approval, signs the spending policy with the device key. Sends only ids. |
| Backend (XYZ) | Quote, INR→USDC conversion, session auth, forwarding to the agent, authoritative job/payment status, HCS + 0G registry. |
| Payment Agent (Omkar) | Verifies the device signature, enforces the policy, signs the Hedera transfer, verifies settlement on-chain, sends the signed callback. |
| x402 gate (Omkar) | Issues the 402 for `POST /api/v1/jobs/{jobId}/execute`, runs verify/settle via Blocky402. |

## Sequence

```
App:      show quote (INR + backend-computed USDC); customer explicitly approves a policy
App:      sign policy with the DEVICE key (Ed25519); POST /payments/authorizations
Backend → Agent: forward. Agent verifies signature, binds customerReference to the key,
                 checks expiry, consumes the nonce, activates the policy.
App:      POST /payments {jobId, quoteId, authorizationId, paymentMethod}  (no amount)
Backend:  look up quote, check not expired, take settlement.amount (USDC), pick merchant
Backend → Agent: POST /payments {…, merchantId, settlementAmount, resourceUrl, quoteExpiresAt}
Agent → Gate: GET /discovery/resources             ← finds the job's paid endpoint itself (x402 Bazaar format)
Agent:    idempotency check, policy check (allowlist, per-tx max, total limit, asset, expiry) + RESERVE
          the amount, all in one step with no waiting in between
Agent:    resource must be an allowlisted origin at /api/v1/jobs/{jobId}/execute
Agent → Gate: POST …/execute (unpaid)              ← 402 + PAYMENT-REQUIRED: the agent READS the price here
Gate:     asks the backend what this job must pay (amount + shop payTo)
Agent:    amount, pay-to account and asset must equal the authorized payment, else nothing is signed
Agent:    x402 policy keeps ONLY the exact vetted option; otherwise nothing is signed
Agent → Gate: retry with PAYMENT-SIGNATURE (partially-signed HTS TransferTransaction)
Gate → Blocky402: /verify then /settle   (facilitator co-signs, pays the fee, submits)
Gate → Agent: 200 + PAYMENT-RESPONSE (tx id)
Agent:    VERIFY on the mirror node: SUCCESS + right token + right merchant + exact amount
Agent → Backend: signed callback (HMAC over raw body), retried with backoff
Backend:  verify, record idempotently by paymentId → payment `settled`, job `awaiting_execution`
App:      polls GET /payments/{id} and GET /jobs/{id}/status
```

## Rules

1. **`settled` comes only from a verified, signed callback** (backend) after on-chain
   verification (agent). A 200 from any API, a facilitator response, or an agent status poll is
   not proof of payment.
2. Both the agent and the **merchant** accounts must be associated with testnet USDC `0.0.429274`,
   otherwise settlement fails with `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`.
3. The amount is decided by the backend. The agent refuses any option that is not exactly
   `{merchant payTo, USDC, hedera:testnet, settlementAmount}`.
4. **Spend is reserved when a payment starts**, in one step with the idempotency check, the policy
   read and the limit check (no waiting in between), so two payments at the same time cannot both
   slip under the total limit and a retried request returns the same payment. It is released only
   when no funds can have moved: nothing was signed, or the facilitator explicitly refused. Once a
   transfer has been signed, any later error keeps the spend and marks the payment "funds may have
   moved". If the facilitator reports success but the mirror node cannot confirm it, the payment is
   `failed` but the spend stays reserved and the tx id is kept for reconciliation. If the response
   was lost and there is no tx id, `recover()` searches the mirror node for the exact agent → shop
   transfer made after signing: it settles the payment if found, or releases the spend once the
   transaction's validity window has passed with no such transfer.
5. Idempotency: the same `(jobId, quoteId, authorizationId)` returns the existing payment; the
   callback is keyed by `paymentId`; uploads honor `Idempotency-Key`.
6. The quote expiry is the payment deadline. A new quote means a new settlement amount.
7. A verified payment moves the job to `awaiting_execution`. It never means the printer finished.

## Headers (x402 v2)

Challenge `PAYMENT-REQUIRED`, client retry `PAYMENT-SIGNATURE`, result `PAYMENT-RESPONSE`; all
base64 JSON. The settlement is read only from `PAYMENT-RESPONSE`.

## What has been verified
## Earlier verification (before the wallet was funded)

Against the live Blocky402 facilitator, with no funded wallet. Kept as a record of the negative
cases; the funded results are under "Real settlements" below:
- The gate issues a correct 402 (`hedera:testnet`, `exact`, asset `0.0.429274`, `feePayer 0.0.7162784`),
  with the price and payee fetched per job from the backend.
- The agent refuses mismatched amounts before signing.
- A signed payload from a throwaway key reaches the facilitator and is rejected with
  `invalid_exact_hedera_payload_signature_invalid`.
- Through the full stack (mock backend → agent → gate): signed-QR pairing, the device-signed
  authorization, backend-computed USDC, the failure path, and the callback receiver's handling of
  forged, tampered, wrong-amount and duplicate callbacks.

## Real settlements

The funded flow has run end to end. From a physical Android phone, through the deployed Cloud Run
backend, payment agent and x402 gate:

- **x402:** `0.0.7162784@1794008216.704679762` (0.024 USDC agent → shop, `SUCCESS` on the mirror
  node, HCS audit entry #9).
- **OfflinePay** (a promise signed on the phone, settled through the same x402 path):
  `0.0.7162784@1794008511.539597966` (HCS entry #10).

More transactions, the HCS audit topic and how to check any payment yourself are in the Hedera
section of the root `README.md`. Not yet verified live: a page physically printing (the shop gateway
and printer are not connected yet) and 0G on-chain records. Neither affects the Hedera payment.
