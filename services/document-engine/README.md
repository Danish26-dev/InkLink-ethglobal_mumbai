# Inklink Document Engine

The deterministic document-processing service for Inklink. It is the only
component that changes document bytes. It contains **no LLM calls**: the agent
layer produces a structured operation plan, and this engine validates that plan
against a closed schema and executes it with plain Python.

```
PDF  ─▶ native in-place edit (PyMuPDF) ───────────────────────────▶ PDF
PDF  ─▶ fallback: PDF→DOCX ─▶ deterministic edit ─▶ DOCX→PDF ─────▶ PDF
DOCX ─▶ deterministic edit (python-docx) ─────────────────────────▶ DOCX
```

## Inklink contract

- Input: `.docx` and digital (text-based) `.pdf` only.
- No OCR. Scanned/image PDFs are rejected with `code: "scanned_pdf"`.
- Output format always equals the uploaded format. Requesting another format
  returns `400 output_format_mismatch`.
- The AI never edits documents. It can only emit operations from the closed
  schema in `app/editing/schema.py`; every plan is re-validated here before any
  file is touched.
- Copy count is **print configuration**, not a document edit. It is handled by
  the Inklink backend and the local printer adapter, never by this engine.
- The engine is a stateless executor with per-job scratch space. The Inklink
  backend owns authoritative job status.

### Supported operation

```json
{ "type": "replace_text", "find": "old text", "replace": "new text" }
{ "type": "replace_text", "find": "old", "replace": "new", "pages": { "from": 1, "to": 3 } }
```

`pages` (1-based, inclusive) is honoured for digital PDFs edited in place. For
anything that cannot enforce page boundaries the engine refuses with
`page_scope_unsupported` rather than editing the whole document.

## Endpoints

| Method | Path                  | Purpose                                       |
|--------|-----------------------|-----------------------------------------------|
| GET    | `/health`             | Service status + LibreOffice availability     |
| GET    | `/operations`         | List supported operation types                |
| POST   | `/inspect`            | Extract plain text (read-only, nothing kept)  |
| POST   | `/process`            | `file` + `plan` → edited file (creates a job) |
| GET    | `/jobs/{id}/download` | Download the edited output                    |
| DELETE | `/jobs/{id}`          | Permanently delete a job's files              |

`/process` form fields: `file`, `plan` (JSON), and optional `output_format`
(accepted only if it equals the input format).

Error bodies are `{ "error": { "code", "message" } }` for engine errors and
`{ "detail": { "code", "message", ... } }` for request validation errors.

## Safety limits

- Uploads above `MAX_UPLOAD_BYTES` (default 50 MB) → `413 file_too_large`.
- At most 50 operations per plan; `find`/`replace` up to 5000 characters.
- A failed `/process` deletes its job directory; jobs older than
  `JOB_TTL_SECONDS` are removed automatically.
- Job ids must be 32-character hex; anything else is a 404.
- CORS is disabled unless `DOCUMENT_ENGINE_ALLOWED_ORIGINS` is set. Call this
  service server-side.

## Local development

```powershell
# from document-engine/
py -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 5001
```

LibreOffice is only needed when a PDF falls back to the conversion pipeline.
Without it, DOCX editing and native PDF editing still work; the fallback returns
`503 libreoffice_unavailable`.

### Tests

```powershell
$env:PYTHONPATH="."
.\venv\Scripts\python.exe -m tests.verify_pipeline           # DOCX pipeline + format contract
.\venv\Scripts\python.exe -m tests.verify_validation         # closed schema
.\venv\Scripts\python.exe -m tests.verify_output_validation  # output checks
.\venv\Scripts\python.exe -m tests.verify_comma_spacing      # native PDF typography
.\venv\Scripts\python.exe -m tests.verify_page_scope         # page-scoped PDF edits
.\venv\Scripts\python.exe -m tests.verify_http               # live HTTP (server must be running)
```

## Docker

```bash
docker build -t inklink-document-engine .
docker run -p 5001:5001 inklink-document-engine
```

## Configuration

See `.env.example`: `PORT`, `HOST`, `WORK_DIR`, `SOFFICE_PATH`,
`CONVERT_TIMEOUT`, `MAX_UPLOAD_BYTES`, `JOB_TTL_SECONDS`,
`DOCUMENT_ENGINE_ALLOWED_ORIGINS`.

## Licensing note

Native PDF editing uses PyMuPDF, which is AGPL-3.0 (or commercially licensed).
See the notice in `app/editing/pdf_native.py`. Distributing or hosting this
engine carries AGPL obligations for the combined work; this is a product/legal
decision for the Inklink maintainers.
