# Inklink architecture report

Diagrams are Mermaid and render on GitHub. Every box and arrow below was checked against the code in this repository. Where something is planned or not deployed, the diagram says so.

Status legend used in this document: **live** (running in the hosted stack), **built** (in the repo and tested, not exercised end to end in the hosted stack), **planned** (not built).

Contents

1. System context
2. Hosting and trust boundaries
3. End-to-end print job (sequence)
4. 0G Private Computer inference and request IDs (sequence)
5. Trust-mode selection (flowchart)
6. Document pipeline: AI proposes, Python executes
7. Hedera x402 payment and settlement (sequence)
8. OfflinePay (sequence)
9. Print execution through the shop gateway (sequence)
10. Job and payment states
11. Execution gates
12. Data model
13. Shop hardware roles
14. Offline-first status
15. Roadmap
16. Evidence checklist for the 0G criteria

---

## 1. System context

```mermaid
flowchart LR
    subgraph Customer["Customer"]
        WEB["Web app PWA<br/>React, no login, no wallet"]
        APP["Mobile app<br/>Expo, device key, SQLite"]
    end

    subgraph Cloud["Google Cloud Run asia-south1"]
        NGINX["inklink-web<br/>nginx serves UI, proxies /api"]
        BE["inklink-backend<br/>FastAPI, job state, gates"]
        AG["inklink-agent<br/>Strands print operator"]
        DE["inklink-document-engine<br/>Python, python-docx, LibreOffice"]
        PA["inklink-payment-agent<br/>spend limits, signing, verification"]
        GATE["inklink-x402-gate<br/>HTTP 402 paywall"]
    end

    subgraph ZG["0G"]
        ROUTER["0G Private Computer router<br/>glm-5.3, TEE modes"]
        GAL["0G Galileo testnet<br/>InklinkRegistry<br/>NOT DEPLOYED YET"]
    end

    subgraph HED["Hedera testnet"]
        FAC["Blocky402 facilitator"]
        LEDGER["USDC transfers"]
        MIRROR["Mirror node"]
        HCS["HCS audit topic"]
    end

    subgraph Shop["Print shop"]
        GW["shop-gateway<br/>outbound only"]
        PRA["local-printer-agent<br/>Windows spooler adapter"]
        PRN["Printer"]
        ESP["ESP32-S3 display<br/>status only"]
    end

    WEB --> NGINX --> BE
    APP --> BE
    BE --> AG
    AG -->|"inference grant, no 0G key"| BE
    BE -->|"per-mode API key"| ROUTER
    AG --> DE
    BE --> DE
    BE --> PA
    PA --> GATE
    GATE --> FAC --> LEDGER
    PA --> MIRROR
    PA --> HCS
    PA -->|"HMAC signed callback"| BE
    BE -.->|"queued records"| GAL
    GW -->|"long poll"| BE
    GW --> PRA --> PRN
    ESP -->|"HTTPS bearer token"| BE
```

Notes

- The browser never talks to 0G, Hedera or the agent. Everything goes through the backend.
- The dashed line to 0G Galileo is an outbox. The contract is written and tested, not deployed, so records queue locally.

---

## 2. Hosting and trust boundaries

```mermaid
flowchart TB
    subgraph PUBLIC["Public internet"]
        U1["Browser"]
        U2["Phone app"]
        W["inklink-web"]
        B["inklink-backend<br/>min=max=1 instance<br/>GCS volume at /data"]
        G["inklink-x402-gate<br/>min 1 instance"]
    end

    subgraph PRIVATE["Private Cloud Run: IAM plus Google ID token only"]
        A["inklink-agent"]
        D["inklink-document-engine"]
        P["inklink-payment-agent<br/>exactly 1 instance"]
    end

    subgraph SECRETS["Secret Manager"]
        S1["0G keys: standard, verified, private"]
        S2["GATEWAY_TOKEN, DEVICE_TOKEN"]
        S3["Hedera signing key, callback HMAC secret"]
    end

    subgraph SHOPNET["Shop network: nothing exposed"]
        SG["shop-gateway"]
        SA["printer adapter 127.0.0.1:7777"]
    end

    U1 --> W --> B
    U2 --> B
    B -->|"ID token"| A
    B -->|"ID token"| D
    B -->|"ID token"| P
    B --- S1
    B --- S2
    P --- S3
    SG -->|"outbound HTTPS"| B
    SG --> SA
```

What each boundary protects

| Boundary | Rule |
|---|---|
| Browser to backend | Anonymous session token. CORS has no wildcard. |
| Backend to private services | Only the backend service account may invoke them. |
| Agent to 0G | The agent never holds a 0G key. It gets a 15-minute grant bound to job, run, trust mode and model. |
| Payment agent to backend | HMAC over the raw request body, sent only after mirror-node verification. |
| Shop to cloud | Outbound connections only. No inbound ports on the shop network. |

---

## 3. End-to-end print job

```mermaid
sequenceDiagram
    autonumber
    actor C as Customer browser
    participant BE as Backend
    participant AG as Strands agent
    participant ZG as 0G Private Computer
    participant DE as Document engine
    participant APP as Mobile app
    participant PA as Payment agent
    participant HD as Hedera
    actor SH as Shopkeeper
    participant GW as Shop gateway
    participant PR as Printer

    C->>BE: POST /web/sessions (anonymous)
    C->>BE: POST /jobs, POST /documents (PDF or DOCX)
    BE->>BE: classify sensitivity, choose trust mode
    C->>BE: POST /jobs/{id}/messages "2 copies, B&W, A4"
    BE->>AG: start run (inference grant)
    AG->>BE: chat completions with grant
    BE->>ZG: chat completion in the chosen trust mode
    ZG-->>BE: answer plus request id
    BE-->>AG: answer
    AG->>DE: validated operations
    DE-->>AG: edited copy, original untouched
    AG-->>BE: print options proposal
    BE-->>C: SSE events (tool calls, trust mode, 0G request id)
    C->>BE: approve edited document
    C->>BE: POST /jobs/{id}/quote
    C->>BE: POST /jobs/{id}/quote/approve
    BE-->>C: single-use payment handoff (QR or deep link)
    C-->>APP: scan or open
    APP->>PA: authorize payment (via backend)
    PA->>HD: x402 transfer, then mirror-node check
    PA-->>BE: HMAC signed settlement callback
    BE->>BE: job awaiting_execution
    SH->>BE: approve job
    BE->>BE: all gates satisfied
    BE->>GW: print request (relay)
    GW->>PR: submit PDF
    PR-->>GW: submitted
    GW-->>BE: result
    BE-->>C: SSE: executing, then completed
```

Document approval and quote approval are separate steps (steps 14 and 16-17).

---

## 4. 0G Private Computer inference and request IDs

This is the 0G path in the main user flow. The agent is a Strands `OpenAIModel` whose base URL is the backend's own inference gateway.

```mermaid
sequenceDiagram
    autonumber
    participant BE as Backend run manager
    participant AG as Strands agent
    participant GW as Backend inference gateway<br/>/api/v1/internal/inference
    participant Z as zerog.py client
    participant R as 0G router<br/>router-api.0g.ai
    participant ST as Job record
    participant UI as Agent Workspace and API

    BE->>BE: select_trust_mode(document, instruction, shop minimum)
    BE->>Z: preflight(mode): key, model, tool support, tier
    alt key or model missing for the mode
        Z-->>BE: refuse, nothing is sent
    else ok
        BE->>GW: issue_grant(job, run, mode, model), 15 min
        BE->>AG: start run with grant as apiKey
        loop each model turn
            AG->>GW: POST /v1/chat/completions (Bearer grant)
            GW->>Z: chat_completion(mode, model, sanitized body)
            Z->>R: POST /chat/completions with that mode's key and trust header
            R-->>Z: completion plus trace, attestation
            Z-->>GW: result with request_id, provider, teeVerified
            GW->>ST: append inference log entry
            GW-->>AG: completion (streamed replay if asked)
        end
        BE->>GW: revoke grant
    end
    ST-->>UI: privacy.lastInference.requestId, provider, teeVerified
```

What is recorded per inference call (`services/backend/app/inference.py`): time, run id, trust mode, model, provider, **request id**, TEE-verified flag, verification result, TEE type and verifier. The last 30 calls are kept per job.

Where the request ID shows up

| Place | How |
|---|---|
| Agent Workspace panel | Row "0G request" under the trust mode (`apps/web/src/workspace/Panels.tsx`). |
| Job API | `GET /api/v1/jobs/{jobId}` returns `privacy.lastInference.requestId`, and `privacy.inferenceCalls` is the count. |

The request ID comes from the 0G router's trace metadata, or from the `ZG-Res-Key` response header when the trace has none (`services/backend/app/zerog.py`).

Rules enforced by the client

- A request in mode M uses only mode M's key. It never substitutes another mode's key.
- The model is pinned. Body-level routing overrides (`provider`, `verify_tee`, `model`, `stream`) are stripped.
- The upstream response is fetched non-streaming so verification is known before output reaches the agent.

What is claimed about verification: the router reports `teeVerified` and a provider attestation. That is a provider-level attestation, not a per-response signature check done by Inklink.

---

## 5. Trust-mode selection

From `services/backend/app/sensitivity.py`. The customer can raise the mode, never lower it below what the document needs.

```mermaid
flowchart TD
    A["New operator run"] --> B{"Document attached?"}
    B -- "no" --> C{"Instruction text sensitive?"}
    C -- "yes" --> P["required = private"]
    C -- "no" --> D["required = configured default<br/>ZERO_G_DEFAULT_TRUST_MODE"]
    B -- "yes" --> E{"Document class"}
    E -- "sensitive or unclassified<br/>no readable text" --> P
    E -- "non-sensitive" --> F{"Instruction text sensitive?"}
    F -- "yes" --> P
    F -- "no" --> S["required = standard"]
    P --> G["effective = strictest of:<br/>required, customer choice or words,<br/>shop minimum"]
    D --> G
    S --> G
    G --> H{"Key and model for the effective mode?"}
    H -- "yes" --> I["Run starts in that mode"]
    H -- "no" --> J["Run refused. No downgrade, no other key."]
```

Customer wording is read too: "private", "confidential" and similar words raise to `private`; "verified", "provable", "auditable" raise to `verified`.

| Mode | Meaning in this project |
|---|---|
| standard | Non-sensitive documents. Any 0G provider, no attestation. |
| verified | Provable execution (TeeML or TeeTLS). The provider may still see plaintext, so it is not used for sensitive documents. |
| private | Personal, financial, identity, confidential or unreadable documents. TeeML only. |

---

## 6. Document pipeline: AI proposes, Python executes

The model never edits a file. It proposes structured operations. Deterministic code validates and applies them.

```mermaid
flowchart LR
    U["Upload PDF or DOCX"] --> CL["Classify<br/>pattern rules in backend"]
    CL --> RUN["Operator run"]
    RUN --> LLM["LLM on 0G<br/>reads the instruction"]
    LLM --> PLAN["Structured operation plan<br/>copies, colour, sides, edits"]
    PLAN --> VAL{"Allow-list and<br/>schema validation"}
    VAL -- "rejected" --> ERR["Error returned to the agent"]
    VAL -- "accepted" --> ENG["Document engine<br/>python-docx, PDF native ops,<br/>LibreOffice DOCX to PDF"]
    ENG --> COPY["Edited copy<br/>original unchanged"]
    COPY --> REV{"Customer reviews<br/>the edited copy"}
    REV -- "reject" --> RUN
    REV -- "approve" --> CFG["Print configuration validated<br/>against the live printer"]
    CFG --> Q["Quote from real page count"]
```

Known limit: the printer adapter prints PDF only. A DOCX job is blocked at execution with a clear message, because the backend does not yet render DOCX to PDF for printing.

---

## 7. Hedera x402 payment and settlement

```mermaid
sequenceDiagram
    autonumber
    participant W as Web app
    participant BE as Backend
    participant APP as Mobile app
    participant PA as Payment agent
    participant GT as x402 gate
    participant FC as Blocky402 facilitator
    participant HD as Hedera testnet
    participant MN as Mirror node
    participant HC as HCS topic

    W->>BE: approve quote
    BE-->>W: handoff token (single use, short lived, no amount)
    W-->>APP: QR or deep link
    APP->>BE: claim handoff
    APP->>BE: signed spending authorization (device key)
    BE->>PA: forward authorization, agent verifies it
    APP->>BE: initiate payment
    BE->>PA: start payment
    PA->>GT: GET paid resource
    GT->>BE: price lookup for the job
    GT-->>PA: 402 with payment requirements
    PA->>PA: exact-match check, allow-listed origin, spend limits
    PA->>GT: retry with signed transfer
    GT->>FC: verify and settle
    FC->>HD: USDC transfer
    FC-->>PA: settle response with transaction id (a claim)
    PA->>MN: fetch transaction
    MN-->>PA: SUCCESS, token transfer to merchant
    PA->>HC: append audit message
    PA->>BE: signed callback (HMAC over raw body)
    BE->>BE: payment settled, job awaiting_execution
    APP->>BE: poll payment status
```

Rules that matter

- A facilitator response with a transaction ID is a **claim**. Only the mirror-node check marks the payment settled.
- If the settlement response is lost, the agent searches the mirror node for the exact transfer instead of guessing (`resolveOutcome` in the payment agent).
- The callback is idempotent on `paymentId` and moves the job to `awaiting_execution`, never to `completed`.
- Browser and ESP32 never initiate or verify payments.

Real evidence is in the README Hedera section (transaction IDs, HCS sequence numbers, and a 60-second self-check).

---

## 8. OfflinePay

A signed promise to pay, settled on Hedera later. It does not skip verification: the job is not paid until the same signed settlement callback arrives.

```mermaid
sequenceDiagram
    autonumber
    participant APP as Mobile app
    participant BE as Backend
    participant PA as Payment agent
    participant HD as Hedera

    APP->>APP: sign voucher with device key
    APP->>BE: POST /api/v1/offline-payments
    BE->>BE: check amount equals quote, 2.00 USDC cap,<br/>5.00 unsettled cap, 2 h validity, device key
    BE-->>APP: PENDING_SETTLEMENT
    BE->>PA: settle voucher (sync loop)
    PA->>HD: pay through the same x402 gate
    PA->>PA: verify on mirror node
    PA-->>BE: signed settlement callback
    BE->>BE: voucher SETTLED, job awaiting_execution
    APP->>BE: GET /offline-payments/{id}
    Note over BE,PA: Unresolved settlement keeps the voucher PENDING_SETTLEMENT<br/>and stops retries. It is never paid twice.
```

---

## 9. Print execution through the shop gateway

```mermaid
sequenceDiagram
    autonumber
    participant BE as Backend
    participant GW as shop-gateway (shop PC)
    participant PA as local-printer-agent
    participant PR as Printer
    participant ES as ESP32-S3 display

    loop long poll with backoff 1 s to 30 s
        GW->>BE: POST /api/v1/gateway/poll (Bearer GATEWAY_TOKEN)
    end
    BE->>BE: try_execute: every gate satisfied?
    BE-->>GW: command: print (document by one-time reference)
    GW->>BE: GET /api/v1/gateway/documents/{token}
    BE-->>GW: PDF bytes
    GW->>PA: POST /print (allow-listed calls only)
    PA->>PR: Windows spooler
    PA-->>GW: PRINT_SUBMITTED
    GW->>BE: POST /api/v1/gateway/results
    PR-->>BE: print_completed (device event)
    BE->>BE: job completed only from a real event
    ES->>BE: GET /api/v1/devices/display (Bearer DEVICE_TOKEN)
    BE-->>ES: status only, no documents or prices
```

Status: the gateway and adapter are built and tested. They have not yet been run against the hosted backend (`/health` reports `printer.connected: false`), so a physical print has not been demonstrated end to end.

---

## 10. Job and payment states

Job states (`JobStatus`):

```mermaid
stateDiagram-v2
    [*] --> created
    created --> awaiting_payment: customer approves quote
    awaiting_payment --> awaiting_execution: verified settlement callback
    awaiting_execution --> executing: gates pass, backend submits to printer
    executing --> completed: real print_completed device event
    awaiting_payment --> cancelled
    awaiting_execution --> failed
    executing --> failed
    completed --> [*]
    cancelled --> [*]
    failed --> [*]
```

Payment states (`PaymentStatus`): `created`, `pending`, `awaiting_authorization`, `processing`, `settled`, `failed`, `expired`, `refunded`. `settled` is set only after the mirror-node check and the signed callback. The diagram above shows the main path and terminal states, not every transition.

---

## 11. Execution gates

`pending_gates()` in `services/backend/app/jobs.py`. All four must be clear before `try_execute` submits.

```mermaid
flowchart TD
    S["try_execute(job)"] --> A{"operator requested execution?"}
    A -- "no" --> W1["wait: awaiting_operator"]
    A -- "yes" --> G1{"print configuration validated?"}
    G1 -- "no" --> X["pending"]
    G1 -- "yes" --> G2{"customer approved the quote?"}
    G2 -- "no" --> X
    G2 -- "yes" --> G3{"payment settled and<br/>job awaiting_execution?"}
    G3 -- "no" --> X
    G3 -- "yes" --> G4{"shop approved?"}
    G4 -- "no" --> X
    G4 -- "yes" --> D{"demo shop?"}
    D -- "yes" --> N["never prints physically"]
    D -- "no" --> F{"PDF and printer online?"}
    F -- "no" --> BL["blocked with a reason"]
    F -- "yes" --> V["re-validate config against live printer"]
    V --> SUB["submit to printer"]
```

---

## 12. Data model

Backend state is a JSON snapshot persisted to a Cloud Storage volume. This is the logical shape, not a SQL schema.

```mermaid
erDiagram
    SHOP ||--o{ JOB : has
    JOB ||--o| DOCUMENT : has
    JOB ||--o{ INFERENCE_LOG_ENTRY : records
    JOB ||--o{ EVENT : publishes
    JOB ||--o| QUOTE : has
    JOB ||--o| PAYMENT : paid_by
    JOB ||--o| OFFLINE_VOUCHER : may_use
    SHOP ||--o{ DEVICE : reports
    JOB {
        string job_id
        string status
        string payment_status
        string requested_trust_mode
        bool customer_approved_quote
        bool shop_approved
    }
    INFERENCE_LOG_ENTRY {
        string requestId
        string trustMode
        string model
        string provider
        bool teeVerified
    }
    PAYMENT {
        string payment_id
        string status
        string transaction_id
        string verified_at
    }
    OFFLINE_VOUCHER {
        string voucher_id
        string state
    }
    DEVICE {
        string deviceId
        float lastSeen
    }
```

The mobile app has its own SQLite database (paired shops and job rows, no keys or document contents).

---

## 13. Shop hardware roles

```mermaid
flowchart LR
    subgraph ShopPC["Shop computer"]
        GW["shop-gateway<br/>relay and allow-list"]
        PA["local-printer-agent<br/>spooler adapter"]
    end
    PR["Printer<br/>produces paper"]
    ESP["ESP32-S3<br/>OLED, buttons, LEDs, buzzer<br/>status display only"]
    BE["Backend"]

    BE <-->|"outbound long poll"| GW
    GW --> PA --> PR
    ESP -->|"heartbeat and display polling"| BE

    ESP -. "never renders PDFs<br/>never starts or verifies payments<br/>never authorizes printing" .- BE
```

| Component | Role | Is not |
|---|---|---|
| Printer | Produces paper | |
| local-printer-agent | Lists printers, validates settings, submits a PDF to the Windows spooler | A queue or history store |
| shop-gateway | Outbound relay, runs four allow-listed adapter calls, fetches the PDF through a one-time reference | A durable queue, or an authorizer |
| ESP32-S3 (`hardware/inklink_display`) | Local status display | A PDF renderer, a gateway or a payment actor |

The ESP32 firmware is standalone published source, not verified on hardware by the committer.

---

## 14. Offline-first status

```mermaid
flowchart LR
    subgraph IMPL["Implemented"]
        I1["Outbound-only shop link"]
        I2["Gateway reconnect with backoff"]
        I3["Device heartbeat, online or offline"]
        I4["Completion only from a real device event"]
        I5["Durable outbox for on-chain records"]
        I6["OfflinePay vouchers with later settlement"]
        I7["LAN-only backend: PRINTER_MODE=direct"]
    end
    subgraph PART["Partial"]
        P1["Gateway result retries<br/>in memory only"]
        P2["SQLite on the phone only"]
    end
    subgraph PLAN["Not built"]
        N1["Durable local print queue"]
        N2["Locally verifiable print authorization"]
        N3["Offline execution of authorized jobs"]
        N4["Idempotent two-way sync, crash recovery"]
        N5["Local document processing"]
    end
```

Security rule for any future offline mode: offline execution must never bypass payment verification or print authorization. A job may run offline only with a backend-issued, job-bound, expiring authorization that the gateway can verify locally. That authorization does not exist yet.

---

## 15. Roadmap

```mermaid
flowchart LR
    P1["Phase 1: connected printing<br/>customer flow, AI plus deterministic edit,<br/>Hedera payment, gateway, ESP32 status<br/>CURRENT"]
    P2["Phase 2: offline-first local<br/>durable queue, signed local authorization,<br/>idempotent sync, crash recovery<br/>PLANNED"]
    P3["Phase 3: distributed<br/>independent gateways, alternative RPC providers,<br/>independent verification<br/>PLANNED"]
    P1 --> P2 --> P3
```

To finish Phase 1: run the shop gateway against the hosted backend, deploy the 0G registry contract, prove one full print on real hardware.

---

## 16. Evidence checklist for the 0G criteria

| Criterion | Status | Evidence |
|---|---|---|
| Inference on 0G Private Computer | Live | `services/backend/app/zerog.py` (`chat_completion`), model `glm-5.3`, three trust-mode keys configured (`/health` reports `zeroG.modes`). |
| Inference in the main user flow | Live | Every AI operator run goes through the inference gateway: section 4. The only exception is the jury demo's labelled deterministic operator, which uses no model and is refused for real shops. |
| Request IDs | Built and shown | Logged per call (`inference.py`), shown in the Agent Workspace and in `GET /api/v1/jobs/{id}` at `privacy.lastInference.requestId`. |
| Working application | Live | Hosted URLs in the README. Checked HTTP 200 on 2026-11-06 for `/portal`, `/jury`, `/demo` and the backend `/health`. |
| What breaks without 0G | Stated | README, "Built on 0G". |
| Public repo, README, setup | Yes | MIT licence, README, `deploy/gcp/README.md`. |
| Demo video, 3 minutes | Not in the repo | Add the link where the submission asks for it. |
| On-chain record on 0G Galileo | Not deployed | Contract written and tested (5 tests). Needs a funded deployer key. |
| iAI sign-in and per-user credit consumption | Not built | Inference is paid with the operator's own 0G keys. Optional bonus. |
