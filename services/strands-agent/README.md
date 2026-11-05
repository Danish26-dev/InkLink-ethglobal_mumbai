# Inklink Strands Agent

The current agent-orchestration service for Inklink. It uses the **Strands
Agents SDK** (`@strands-agents/sdk`) with a **Google Vertex AI (Gemini)** model
to turn a customer's natural-language instruction into a **validated,
deterministic operation plan**, executes it through the Inklink **Document
Engine**, and records a **print-options proposal**.

> Status: aligned with Inklink's contracts. Inklink's target orchestration
> framework is **Google ADK**; this module has **not** been converted to ADK. The schemas, tool callback logic,
> system prompt and HTTP contract are framework-neutral and can be re-hosted;
> the `Agent`/`tool` wiring and result parsing are Strands-specific.

The LLM never edits document bytes. It only selects and validates operations;
the Document Engine performs the edit and re-validates. Nothing the agent
returns is an approval: the Inklink backend owns customer approval, payment and
job status.

```
customer instruction
  → Strands Agent (Vertex AI Gemini)
      → inspect_document        (Document Engine /inspect)
      → plan_operations         (validate against the closed schema)
      → execute_operation_plan  (Document Engine /process)
      → set_print_options       (record copies / colour / paper / sides proposal)
  → human-readable confirmation + structured result
```

## Tools

| Tool | Responsibility |
|------|----------------|
| `inspect_document` | Read the document's text (never modifies it). |
| `plan_operations` | Validate proposed edits against the closed schema. |
| `execute_operation_plan` | Send the validated plan to the Document Engine. |
| `set_print_options` | Record print settings (copies, colour, paper, orientation, sides, printer). |

Document-edit operation (mirrors the engine's closed schema):

```json
{ "type": "replace_text", "find": "old", "replace": "new", "pages": { "from": 1, "to": 3 } }
```

Copies are **print options**, never a document operation; a `set_copies`
operation is rejected. The output format always matches the
uploaded format; the agent cannot request a conversion.

## Reliability rules enforced

- Every plan is validated (zod) before execution and again inside the tool
  callback; the Document Engine re-validates and is the final authority.
- No tool can run code, shell, or filesystem operations.
- Ambiguous instructions → the agent asks for clarification and does not edit.
- Text-not-found is reported honestly; terminal engine errors stop the loop.
- Model calls retry only on throttling (bounded backoff).

## HTTP API

`POST /api/edit` (multipart, max 50 MB)
- `file` — the `.docx` or `.pdf`
- `instruction` — natural-language instruction

Returns `{ success, result: { executed, message, plan?, document?, printOptions?, printOptionsOnly?, needsClarification?, errorCode? } }`.

`GET /api/health` — agent status + Document Engine reachability.

## Configuration

See `.env.example`. Credentials are never read by application code; Vertex AI
uses Application Default Credentials.

| Var | Purpose |
|-----|---------|
| `PORT` / `HOST` | Listen port (4000) and bind address (`127.0.0.1`) |
| `DOCUMENT_ENGINE_URL` | Document Engine base URL |
| `AGENT_ALLOWED_ORIGINS` | Browser origins allowed via CORS (empty = disabled) |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` | Vertex AI target (required) |
| `VERTEX_AI_MODEL_ID` | Gemini model id (required) |
| `MODEL_TEMPERATURE`, `VERTEX_MAX_OUTPUT_TOKENS`, `VERTEX_THINKING_BUDGET` | Generation settings |
| `ENGINE_INSPECT_TIMEOUT_MS`, `ENGINE_PROCESS_TIMEOUT_MS` | Per-call engine budgets |
| `AGENT_THROTTLE_RETRIES`, `AGENT_THROTTLE_DELAYS_MS` | 429 retry policy |

## Develop & run

```bash
npm ci --legacy-peer-deps
cp .env.example .env          # set the Vertex AI values
gcloud auth application-default login
npm run start:dev             # or: npm run build && npm start
```

## Tests

```bash
npm run typecheck
npm run test:unit                                   # no network, no credentials

# Integration: tools against the REAL Document Engine (no model).
DOCUMENT_ENGINE_URL=http://127.0.0.1:5001 npm run test:integration

# Real Vertex AI round-trip: opt-in, skipped (never faked) unless enabled.
RUN_VERTEX_TESTS=1 npm run test:integration        # needs ADC + engine running
```
