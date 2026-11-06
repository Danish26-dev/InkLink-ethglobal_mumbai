# Docker images and the local production-like stack

Every server-side component ships as a container. The same images run in `docker compose` on a
laptop and on Cloud Run (see [CLOUD_SHELL_DEPLOYMENT.md](CLOUD_SHELL_DEPLOYMENT.md)). The Expo app,
the local printer adapter, the shop gateway connector and the ESP32 firmware are **not** containers
in this deployment: they run on the phone, the shop computer and the device.

## Images

| Image | Dockerfile | Build context | Port | Health |
|---|---|---|---|---|
| backend | `services/backend/Dockerfile` | `services/backend` | `$PORT` (8080) | `GET /health` |
| document engine | `services/document-engine/Dockerfile` | `services/document-engine` | `$PORT` (5001) | `GET /health` |
| Strands agent | `services/strands-agent/Dockerfile` | repo root | `$PORT` (8080) | `GET /api/health` |
| payment agent + x402 gate | `services/payment-agent/Dockerfile` | repo root | 4021 / 4022 | `GET /health` |
| web (landing + PWA, nginx) | `deploy/web/Dockerfile` | repo root | `$PORT` (8080) | `GET /healthz` |

Common properties:

- **Multi-stage** builds (backend, engine, agent, web): dependencies and compilers stay in the
  builder; runtime images contain the app and production dependencies only (no pytest, no
  TypeScript, no tsx, no Vite).
- **Non-root**: backend and engine run as uid 10001, agent and payment agent as `node` (1000), web as
  nginx-unprivileged (101).
- **`$PORT`**: every service listens on the port Cloud Run injects.
- **Graceful shutdown**: the server process is PID 1 and handles SIGTERM. The backend flushes
  pending state (`Store.close()`) and releases printer-relay long-polls; uvicorn waits up to 8 s for
  in-flight requests.
- **Logs** go to stdout/stderr (Cloud Logging collects them). Secrets are never logged.
- **No secrets in layers**: `.dockerignore` files exclude `.env*`, keys, `data/`, `venv/` and
  `node_modules`; the backend image sets `INKLINK_BACKEND_DOTENV=0` so it never reads a `.env` file.
  All configuration is environment at run time.
- **HEALTHCHECK** instructions for docker; Cloud Run uses the startup/liveness probes in the
  rendered service manifests (same paths).

Build any image directly:

```bash
docker build -t inklink-backend services/backend
docker build -t inklink-document-engine services/document-engine
docker build -f services/strands-agent/Dockerfile -t inklink-agent .
docker build -f services/payment-agent/Dockerfile -t inklink-payment-agent .
docker build -f deploy/web/Dockerfile -t inklink-web .
```

## Local stack with docker compose

```bash
cp deploy/env/compose.env.example .env    # git-ignored; generate tokens with: openssl rand -hex 32
docker compose up -d --build              # backend, agent, document engine, web
docker compose ps                         # all four should be "healthy"
```

- Web: <http://localhost:8080/> (landing), `/portal`, `/shop/login`, `/jury`
- Backend API directly: <http://localhost:8000/health>
- Host ports are configurable: `WEB_HOST_PORT=8180 BACKEND_HOST_PORT=8100 docker compose up -d`
- Payments (needs a funded Hedera testnet agent account in `.env`):
  `docker compose --profile payments up -d`

`docker-compose.yml` gives each container only the variables it needs: the 0G keys reach only the
backend, the Hedera private key only the payment agent. Everything binds to `127.0.0.1`.

The backend reaches the local printer adapter on the host (`PRINTER_AGENT_URL`,
default `http://host.docker.internal:7777`). The adapter binds to loopback by default, so for the
compose stack either start it with `PRINTER_AGENT_HOST=0.0.0.0` and a `PRINTER_AGENT_TOKEN` (same value
in `.env`), or use the relay mode
exactly like the cloud: set `PRINTER_MODE=relay` and a `GATEWAY_TOKEN` in `.env` and run
`services/shop-gateway` with `BACKEND_URL=http://127.0.0.1:8000`.

Shopkeeper accounts: `docker compose exec backend python -m app.manage create-shopkeeper --email you@example.com --name "Owner" --shops shop_001`
(run it while the backend is stopped, or restart the backend afterwards: the running process owns
`state.json`). On Cloud Run use `BOOTSTRAP_SHOPKEEPER_EMAIL` + the `BOOTSTRAP_SHOPKEEPER_PASSWORD` secret.

Stop: `docker compose down` (volumes `backend-data` and `payment-data` are kept; add `-v` only if you
really want to delete local state).

## What was verified locally

- All five images build (`docker build`), and `docker compose up` brings backend, agent, engine and
  web to *healthy*.
- Through the web container: landing, `/portal`, `/shop/login`, `/pwa/`, `/sw.js` and `/api/v1/health`
  return 200; a customer session, job, PDF upload and SSE stream (with heartbeats) work through nginx;
  a real operator run went web → backend → agent (0G inference) → document engine and back.
- Not verified locally: Cloud Run itself, the Cloud Storage volume, Secret Manager mounts, Cloud Run
  IAM / ID tokens, real Hedera settlement.
