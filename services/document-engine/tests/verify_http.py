"""Live HTTP smoke test against a running Document Engine.

Uses only the stdlib (urllib) to avoid extra deps and shell-quoting issues.
Covers: /process + download, job deletion, the output-format contract, and
rejection of the retired set_copies operation.

Run (with the server running):
    venv/Scripts/python.exe -m tests.verify_http
Override the target with DOCUMENT_ENGINE_URL (default http://127.0.0.1:5001).
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from docx import Document

BASE = os.getenv("DOCUMENT_ENGINE_URL", "http://127.0.0.1:5001").rstrip("/")


def make_docx(path: Path) -> None:
    d = Document()
    d.add_paragraph("Hello John from Acme Corp")
    d.save(str(path))


def multipart(fields: dict[str, str], files: dict[str, tuple[str, bytes]]) -> tuple[bytes, str]:
    boundary = "----inklink" + uuid.uuid4().hex
    body = io.BytesIO()
    for name, value in fields.items():
        body.write(f"--{boundary}\r\n".encode())
        body.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.write(value.encode())
        body.write(b"\r\n")
    for name, (filename, content) in files.items():
        body.write(f"--{boundary}\r\n".encode())
        body.write(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode()
        )
        body.write(b"Content-Type: application/octet-stream\r\n\r\n")
        body.write(content)
        body.write(b"\r\n")
    body.write(f"--{boundary}--\r\n".encode())
    return body.getvalue(), f"multipart/form-data; boundary={boundary}"


def request(url: str, *, method: str = "GET", body: bytes | None = None,
            content_type: str | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method)
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def post_process(sample: Path, plan: dict, **fields: str) -> tuple[int, dict]:
    body, ctype = multipart(
        fields={"plan": json.dumps(plan), **fields},
        files={"file": (sample.name, sample.read_bytes())},
    )
    status, raw = request(f"{BASE}/process", method="POST", body=body, content_type=ctype)
    return status, json.loads(raw.decode() or "{}")


def main() -> int:
    failures: list[str] = []
    with tempfile.TemporaryDirectory() as td:
        sample = Path(td) / "http_test.docx"
        make_docx(sample)

        # 1. Happy path: replace + download.
        status, result = post_process(
            sample, {"operations": [{"type": "replace_text", "find": "John", "replace": "Jane"}]}
        )
        print("--- /process ---", status)
        print(json.dumps(result, indent=2))
        if status != 200:
            failures.append(f"/process returned {status}")
        else:
            if result["changes"]["total_replacements"] != 1:
                failures.append("expected exactly one replacement")
            if "copies" in result["changes"]:
                failures.append("change summary must not contain print copies")
            if result["output_format"] != "docx":
                failures.append("output format must match the uploaded format")
            dl_status, dl = request(f"{BASE}{result['download_url']}")
            out = Path(td) / "downloaded.docx"
            out.write_bytes(dl)
            text = "\n".join(p.text for p in Document(str(out)).paragraphs)
            if dl_status != 200 or "Jane" not in text or "John" in text:
                failures.append("downloaded document does not contain the edit")

            # 2. Job deletion removes the files.
            del_status, _ = request(f"{BASE}/jobs/{result['job_id']}", method="DELETE")
            again, _ = request(f"{BASE}{result['download_url']}")
            if del_status != 200 or again != 404:
                failures.append("job files still downloadable after DELETE")

        # 3. Output format must equal input format.
        status, body = post_process(
            sample,
            {"operations": [{"type": "replace_text", "find": "John", "replace": "Jane"}]},
            output_format="pdf",
        )
        code = (body.get("error") or {}).get("code")
        if status != 400 or code != "output_format_mismatch":
            failures.append(f"DOCX->PDF request should be 400 output_format_mismatch (got {status} {code})")

        # 4. The retired set_copies operation is rejected.
        status, body = post_process(sample, {"operations": [{"type": "set_copies", "copies": 2}]})
        code = (body.get("detail") or {}).get("code")
        if status != 422 or code != "invalid_plan":
            failures.append(f"set_copies should be rejected as invalid_plan (got {status} {code})")

        # 5. Path-traversal style job ids are rejected.
        status, _ = request(f"{BASE}/jobs/..%2F..%2Fetc/download")
        if status != 404:
            failures.append(f"malformed job id should be 404 (got {status})")

    if failures:
        print("\nHTTP E2E FAILED:")
        for f in failures:
            print("  -", f)
        return 1
    print("\nHTTP E2E PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
