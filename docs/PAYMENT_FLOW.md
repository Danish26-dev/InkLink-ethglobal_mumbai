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
Agent:    policy check (allowlist, per-tx max, total limit, asset, expiry) + RESERVE the amount
Agent:    resource must be an allowlisted origin at /api/v1/jobs/{jobId}/execute
Agent → Gate: POST …/execute                       ← 402 + PAYMENT-REQUIRED
Gate:     asks the backend what this job must pay (amount + shop payTo)
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
4. **Spend is reserved when a payment starts**, synchronously with the limit check, so concurrent
   payments cannot both slip under the total limit. It is released only when no funds can have
   moved. If the facilitator reports success but the mirror node cannot confirm it, the payment is
   `failed` but the spend stays reserved and the tx id is kept for reconciliation.
5. Idempotency: the same `(jobId, quoteId, authorizationId)` returns the existing payment; the
   callback is keyed by `paymentId`; uploads honor `Idempotency-Key`.
6. The quote expiry is the payment deadline. A new quote means a new settlement amount.
7. A verified payment moves the job to `awaiting_execution`. It never means the printer finished.

## Headers (x402 v2)

Challenge `PAYMENT-REQUIRED`, client retry `PAYMENT-SIGNATURE`, result `PAYMENT-RESPONSE`; all
base64 JSON. The settlement is read only from `PAYMENT-RESPONSE`.

## What has been verified

Against the live Blocky402 facilitator, with no funded wallet:

- The gate issues a correct 402 (`hedera:testnet`, `exact`, asset `0.0.429274`, `feePayer 0.0.7162784`),
  with the price and payee fetched per job from the backend.
- The agent refuses mismatched amounts before signing.
- A signed payload from a throwaway key reaches the facilitator and is rejected with
  `invalid_exact_hedera_payload_signature_invalid`.
- Through the full stack (mock backend → agent → gate): signed-QR pairing, the device-signed
  authorization, backend-computed USDC, the failure path, and the callback receiver's handling of
  forged, tampered, wrong-amount and duplicate callbacks.

**Not yet done: a real funded settlement.** It needs the funded agent wallet and a USDC-associated
merchant account. Until then there is no transaction id and no HashScan proof.
