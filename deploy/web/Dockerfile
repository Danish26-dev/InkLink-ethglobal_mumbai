# Inklink web: landing page (repo root Vite app) + PWA (apps/web) behind nginx.
# Build from the REPO ROOT:
#   docker build -f deploy/web/Dockerfile -t inklink-web .
# Run:
#   docker run -p 8080:8080 -e BACKEND_URL=http://host.docker.internal:8000 inklink-web
#
# BACKEND_URL: origin of the Inklink backend, no trailing slash and no path
# (e.g. https://inklink-backend-xxxxx.asia-south1.run.app). nginx proxies /api to it,
# so the browser only ever talks to this origin.

# ---- build: landing page ----
FROM node:22-slim AS landing
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json postcss.config.js tailwind.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build

# ---- build: PWA ----
FROM node:22-slim AS pwa
WORKDIR /app
COPY packages/shared-schemas/package.json packages/shared-schemas/tsconfig.json packages/shared-schemas/
COPY packages/shared-schemas/src packages/shared-schemas/src
RUN cd packages/shared-schemas && npm install --no-audit --no-fund && npm run build
COPY apps/web/package.json apps/web/package-lock.json apps/web/
RUN cd apps/web && npm ci --no-audit --no-fund
COPY apps/web apps/web
RUN cd apps/web && npm run build

# ---- runtime: unprivileged nginx (uid 101), static files only ----
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
ENV PORT=8080 \
    BACKEND_URL=http://backend:8080 \
    NGINX_ENVSUBST_FILTER="^(PORT|BACKEND_URL)$"
COPY --from=landing /src/dist /usr/share/nginx/html
COPY --from=pwa /app/apps/web/dist /usr/share/nginx/html/pwa
COPY deploy/web/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
# nginx handles SIGQUIT for graceful shutdown; the base image sets STOPSIGNAL SIGQUIT.
