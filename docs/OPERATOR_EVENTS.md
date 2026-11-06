# Print Operator event stream (proposed, v0.1)

Types: `packages/shared-schemas/src/operator-events.ts`. Additive to API Contracts 1–8; no existing endpoint, enum, network or asset changes.

## Transport

```
POST /api/v1/jobs/{jobId}/tickets        -> { ticket, expiresInSeconds: 60 }   (bearer: web session or shop token)
GET  /api/v1/jobs/{jobId}/events?ticket=<ticket>&after=<lastSeq>               (text/event-stream)
```

- `EventSource` cannot send headers, so each connection uses a single-use 60 s ticket.
- Each SSE message: `id: <seq>`, `event: <type>`, `data: <OperatorEvent JSON>`.
- `seq` increases per job. On reconnect the client gets a new ticket and passes `after=<lastSeq>` (or `Last-Event-ID`); the backend replays the job log after that point.
- Every 15 s of silence the backend sends `event: heartbeat` (`data: {"ts": <epoch>}`), not part of the job log and without an `id`. The web client reconnects if it hears nothing for 40 s, which catches connections a proxy left half-open.

```ts
{ seq: number, jobId: string, type: OperatorEventType, source: "agent"|"backend"|"payment"|"device", ts: ISO, payload }
```

## Event types

| type | source | emitted when |
|---|---|---|
| `agent_started` | agent | a run starts; carries the provider, model, the 0G trust mode used and `trustSelection` (required / requested / effective, reason) |
| `agent_thinking` | agent | customer-visible model text (not hidden reasoning) |
| `tool_started` | agent | an allowlisted tool is invoked, with its validated input |
| `configuration_updated` | agent | a setter changed a value (after validation), before its `tool_succeeded` |
| `tool_succeeded` | agent | the tool's deterministic code returned success |
| `tool_failed` | agent / backend | the tool failed; carries the real `{code, message}` |
| `document_processed` | agent | the Document Engine produced an edited file (`engineJobId` is stripped before browsers) |
| `printer_readiness_updated` | agent / backend | discovery or a readiness check returned |
| `approval_required` | backend | a customer quote, payment or shop approval is needed |
| `payment_status_updated` | payment | only after the signed settlement callback was verified |
| `execution_authorized` | backend | the backend (never the model) submitted the job to the spooler |
| `job_status_updated` | backend | Contract 8 status / payment / device changed |
| `agent_finished` | agent / backend | `completed`, `needs_clarification`, `failed` or `unavailable` |

## Rules the UI relies on

- A control value changes only on `configuration_updated`. A success mark appears only on `tool_succeeded`.
- Any `configuration_updated` invalidates an earlier validation.
- If the run cannot start (the key for the selected trust mode is missing, the model can't serve that mode, or the agent is unreachable), it emits `agent_finished` with `outcome: "unavailable"` and no tool events. Nothing is sent to the agent or to 0G. There is no fallback to a weaker mode or another provider.
- `approval_required` with `kind: "document_review"` means the operator produced an edited copy that the customer must approve or reject before pricing.
- `executing` means the spooler accepted the job, not that it printed. Only the shop marks a job `completed`.

## Agent ↔ backend

- Backend → agent: `POST /api/operator/runs` (multipart, bearer `AGENT_SERVICE_TOKEN`), streaming NDJSON `HarnessEvent`s. The backend assigns `seq`, `jobId` and `source`. The `inference` field carries a per-run grant `{baseUrl, token, model, trustMode}` for the backend's 0G gateway. The agent holds no 0G key.
- Agent → backend (model calls): `POST /api/v1/internal/inference/v1/chat/completions`, bearer = grant. The backend calls 0G with that mode's key and `X-0G-Provider-Trust-Mode`.
- Agent → backend: `POST /api/v1/internal/jobs/{jobId}/execution-requests`. The agent has no print tool. The backend re-validates the config with the printer adapter and prints only when every gate is met.
