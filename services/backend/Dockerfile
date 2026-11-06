# Inklink backend (FastAPI). Build context: services/backend
#   docker build -t inklink-backend services/backend
#
# - multi-stage: dependencies are installed into a virtualenv in the builder and only
#   that virtualenv + the app source reach the runtime image (no pip cache, no pytest)
# - runs as an unprivileged user; writes only to DATA_DIR (/data: a volume locally,
#   a Cloud Storage volume on Cloud Run)
# - no secrets in any layer: configuration comes from the environment at runtime
#   (.env files are excluded by .dockerignore and never read in the container)

FROM python:3.12-slim AS builder
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY requirements.txt .
# pytest is a test-only dependency.
RUN python -m venv /opt/venv \
    && grep -viE '^pytest' requirements.txt > requirements.runtime.txt \
    && /opt/venv/bin/pip install -r requirements.runtime.txt

FROM python:3.12-slim AS runtime
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    INKLINK_BACKEND_DOTENV=0 \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data
RUN useradd --create-home --uid 10001 inklink \
    && mkdir -p /data \
    && chown inklink:inklink /data
WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
COPY app ./app
USER inklink
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import os,urllib.request,sys; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8080\")}/health', timeout=4); sys.exit(0)" || exit 1
# exec: uvicorn is PID 1 and receives SIGTERM directly (graceful shutdown: in-flight
# requests finish, pending state is flushed). X-Forwarded-For is deliberately NOT
# trusted from arbitrary hops (uvicorn default: loopback only), so a client cannot
# spoof its address to bypass the per-address login lockout or the local-only checks.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --timeout-graceful-shutdown 8 --no-server-header"]
