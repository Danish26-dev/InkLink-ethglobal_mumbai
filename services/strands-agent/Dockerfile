# Inklink Strands Agent (print operator). Build from the REPO ROOT so the shared
# contracts package is in the build context:
#   docker build -f services/strands-agent/Dockerfile -t inklink-agent .
#
# - multi-stage: TypeScript is compiled in the builder; the runtime image has the
#   compiled JavaScript, production dependencies only, and no tsx/typescript
# - the @strands-agents/sdk requires Node 22+
# - no credentials in any layer. With INKLINK_MODEL_PROVIDER=0g-private-computer
#   (default) this service holds no model key at all: the backend issues a per-run
#   inference grant. Vertex AI (optional) uses the runtime service account (ADC).

FROM node:22-slim AS builder
WORKDIR /app
# 1. Shared contracts, compiled to dist/ (consumed through file:../../packages/shared-schemas).
COPY packages/shared-schemas/package.json packages/shared-schemas/tsconfig.json packages/shared-schemas/
COPY packages/shared-schemas/src packages/shared-schemas/src
RUN cd packages/shared-schemas && npm install --no-audit --no-fund && npm run build
# 2. Agent dependencies (incl. dev, for tsc). Strict optional peer deps of the SDK
#    need legacy resolution; the lockfile keeps the build reproducible.
COPY services/strands-agent/package.json services/strands-agent/package-lock.json services/strands-agent/
RUN cd services/strands-agent && npm ci --legacy-peer-deps --no-audit --no-fund
# 3. Compile the service (src only; tests are not part of the image).
COPY services/strands-agent/tsconfig.json services/strands-agent/
COPY services/strands-agent/src services/strands-agent/src
RUN cd services/strands-agent \
    && npx tsc -p tsconfig.json --sourceMap false \
    && test -f dist/src/index.js \
    && npm prune --omit=dev --legacy-peer-deps --no-audit --no-fund

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
# The shared package is resolved through a symlink in node_modules: keep the same layout.
COPY --from=builder --chown=node:node /app/packages/shared-schemas/package.json /app/packages/shared-schemas/package.json
COPY --from=builder --chown=node:node /app/packages/shared-schemas/dist /app/packages/shared-schemas/dist
COPY --from=builder --chown=node:node /app/services/strands-agent/package.json /app/services/strands-agent/package.json
COPY --from=builder --chown=node:node /app/services/strands-agent/node_modules /app/services/strands-agent/node_modules
COPY --from=builder --chown=node:node /app/services/strands-agent/dist /app/services/strands-agent/dist
WORKDIR /app/services/strands-agent
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node is PID 1 (no npm wrapper) so SIGTERM reaches the process directly.
CMD ["node", "dist/src/index.js"]
