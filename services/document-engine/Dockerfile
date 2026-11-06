# Inklink Document Engine. Build context: services/document-engine
#   docker build -t inklink-document-engine services/document-engine
# Python service for deterministic PDF/DOCX editing.
# LibreOffice is installed so DOCX -> PDF rendering works for PDF jobs that fall
# back from native in-place editing to the conversion pipeline.
#
# Multi-stage: Python dependencies are installed into a virtualenv in the builder;
# the runtime image gets that virtualenv, the app and the system packages only.

FROM python:3.12-slim AS builder
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY requirements.txt .
RUN python -m venv /opt/venv && /opt/venv/bin/pip install -r requirements.txt

FROM python:3.12-slim AS runtime
# System dependencies:
#  - libreoffice-writer: headless DOCX <-> PDF conversion (soffice)
#  - fonts: so converted PDFs render text correctly
#  - libgl1 / libglib: runtime libs required by opencv (pulled in by pdf2docx)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer \
    fonts-dejavu \
    fonts-liberation \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
# App source
COPY app ./app
# Run as an unprivileged user; it only needs to write its scratch directory
# (and a HOME for the LibreOffice profile).
RUN useradd --create-home --uid 10001 engine \
    && mkdir -p /app/_work \
    && chown -R engine:engine /app/_work
USER engine
ENV PATH=/opt/venv/bin:$PATH \
    PORT=5001 \
    WORK_DIR=/app/_work \
    SOFFICE_PATH=/usr/bin/soffice \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"5001\")}/health', timeout=4)" || exit 1
# exec: uvicorn is PID 1 and handles SIGTERM (graceful shutdown).
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --timeout-graceful-shutdown 8 --no-server-header"]
