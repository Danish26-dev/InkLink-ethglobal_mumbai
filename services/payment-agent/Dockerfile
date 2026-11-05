# Payment agent + x402 gate image. Build from the REPO ROOT so the shared package is in context:
#   docker build -f services/payment-agent/Dockerfile -t inklink-payment-agent .
# One image, two commands: `npm start` (agent, :4021) and `npm run gate` (gate, :4022).
FROM node:22-slim

WORKDIR /app

# 1. Shared contracts, built to dist/ (the agent consumes the compiled output).
COPY packages/shared-schemas/package.json packages/shared-schemas/tsconfig.json packages/shared-schemas/
COPY packages/shared-schemas/src packages/shared-schemas/src
RUN cd packages/shared-schemas && npm install --no-audit --no-fund && npm run build

# 2. The agent. `npm ci` links @inklink/shared-schemas from ../../packages/shared-schemas.
COPY services/payment-agent/package.json services/payment-agent/package-lock.json services/payment-agent/
RUN cd services/payment-agent && npm ci --no-audit --no-fund
COPY services/payment-agent services/payment-agent

WORKDIR /app/services/payment-agent

# State lives on a mounted volume, never in the image. Run as the unprivileged "node" user.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
    AGENT_STATE_FILE=/data/agent-state.json
USER node
VOLUME ["/data"]
EXPOSE 4021 4022

CMD ["npm", "start"]
