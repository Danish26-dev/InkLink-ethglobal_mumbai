# Inklink — Hosting the payment agent and gate on GCP

Status: **prepared, not deployed, and the image has not been build-tested** (no Docker engine was
running on the dev machine). Nothing here has run on GCP yet.

## What gets hosted, and what does not

| Piece | Hosted here? | Notes |
|-------|--------------|-------|
| Payment agent (`:4021`) | Yes | Holds the funded Hedera key. **Internal only.** |
| x402 gate (`:4022`) | Yes | Prices jobs from the backend. Never sees the agent key. **Internal only.** |
| Inklink backend (FastAPI) | XYZ's | Needs to be reachable by the agent for the settlement callback and by the gate for pricing. |
| Website (Danish's) | Separate | Static site; unrelated to this guide. |
| Shop gateway | No | Runs on the shop's own network. The phone reaches it over local Wi-Fi, not through GCP. |

Hosting the payment services does not change the phone-to-shop flow. Only the payment leg goes
through the cloud.

## Design choices

- **One small VM (Compute Engine), one agent instance.** The agent keeps spend limits and in-flight
  payments in a state file and must be the only writer. A stateless platform (Cloud Run with
  several instances) would break that, so use a VM with a persistent Docker volume.
- **No public ports for the agent or gate.** Ingress stays default-deny except SSH. The compose file
  binds both to `127.0.0.1`. Only the backend should be exposed, over HTTPS.
- **Least privilege.** The gate gets its own env file and a placeholder instead of the private key.
- **Testnet only.** The wallet is a throwaway Hedera testnet account. Never put a mainnet key here.

## Steps (you run these; they need your GCP project and billing)

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable compute.googleapis.com

gcloud compute instances create inklink-payments \
  --zone=asia-south1-a --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=20GB
```

1. SSH in (`gcloud compute ssh inklink-payments --zone=asia-south1-a`) and install Docker Engine
   with the Compose plugin: https://docs.docker.com/engine/install/debian/
2. Get the code: `git clone https://github.com/Danish26-dev/InkLink-ethglobal_mumbai` and check out
   `feat/native-app-hedera-x402`.
3. `cd deploy`, then `cp agent.env.example .env.agent` and `cp gate.env.example .env.gate`.
   Fill them in. Then `chmod 600 .env.agent .env.gate`. These files are git-ignored (`.env.*`).
4. `docker compose up -d --build`
5. Check: `curl http://127.0.0.1:4021/health` should return `{"ok":true,...}`.
6. Logs: `docker compose logs -f agent`.

Stop and restart are safe: the agent re-verifies in-flight payments on startup and resends
undelivered callbacks. Never run two agents against the same state.

## Connecting the backend

- Backend to agent: `POST http://<vm-internal-ip>:4021/api/v1/payments` with the bearer token. If
  the backend runs on another host, either put both in one VPC and publish the agent port on the
  VPC interface only (not the internet), or run the backend on the same VM.
- `resourceUrl` sent to the agent must be `http://gate:4022/api/v1/jobs/{jobId}/execute`, matching
  `ALLOWED_RESOURCE_ORIGINS`.
- Agent to backend: `BACKEND_EVENT_URL` must be reachable from the VM.

## Before going live

- [ ] Real merchant account ID from XYZ, USDC associated.
- [ ] Shared secrets sent privately and identical on both sides.
- [ ] HTTPS in front of the backend (a domain plus Caddy or a load balancer).
- [ ] Optional hardening: move secrets to Secret Manager instead of files on the VM.
- [ ] Build-test the image once (`docker build -f services/payment-agent/Dockerfile .` from the
      repo root) and fix anything it reveals.
