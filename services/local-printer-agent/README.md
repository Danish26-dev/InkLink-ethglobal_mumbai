# Inklink Local Printer Agent

A small **local printer adapter** that runs on the **print shop's Windows
computer** (the machine physically connected to the printer) and exposes real
printer operations to the Inklink backend over HTTP. A browser or a
cloud/container backend cannot reliably control a local USB/network printer;
this adapter is the trust boundary that can.

> It is a Windows print spooler adapter. It is **not** ESP32-S3 firmware and does not talk to any
> microcontroller. ESP32-S3 device integration is a separate component.

## Role in Inklink

```
Inklink backend ──(approved job + validated config)──▶ Local Printer Agent ──▶ Windows spooler ──▶ printer
```

- The backend owns job status, customer approval, payment and shop approval.
  It must only call `/print` for a job that is already approved.
- This adapter re-validates the configuration against live discovery and
  submits the PDF. It does not keep a job queue or job history.
- Hardware-specific code lives only in `src/windowsPrinter.js` and
  `scripts/discover-printers.ps1`; validation (`src/printConfig.js`) and HTTP
  (`src/index.js`) are platform-neutral.

## Capabilities (allowlisted — no generic shell)

- `GET  /health` — liveness.
- `GET  /printers` — real printer discovery (name, driver, port, status,
  default flag). Colour/duplex support cannot be queried reliably and is
  reported as `null` (unknown), never fabricated.
- `GET  /printers/:id/availability` — is a specific printer available now.
- `POST /validate` — validate `{ config }` against the discovered printers.
- `POST /print` — submit an **approved** job (`{ config, documentBase64 }`).
  The body must be a PDF. A success is `PRINT_SUBMITTED`: the Windows spooler
  accepted the job. It is **not** confirmation that paper was printed.

`config` must contain all six fields: `printerId`, `copies` (1–999),
`colorMode` (`color`|`monochrome`), `paperSize` (`A4`|`Letter`|`Legal`),
`orientation` (`portrait`|`landscape`), `sides` (`one-sided`|
`two-sided-long-edge`|`two-sided-short-edge`). The agent's print-options
proposal has every field optional, so the backend must fill defaults first.

`submissionId` in a successful response is an adapter-generated reference, not
a Windows spooler job id. There is no cancel or job-status endpoint yet.

## Requirements

- Windows (uses `Get-Printer` / `Win32_Printer` via a PowerShell script file).
  Other operating systems return `UNSUPPORTED_OS` from discovery.
- Node 18+.
- [`pdf-to-printer`](https://www.npmjs.com/package/pdf-to-printer), which
  bundles SumatraPDF to spool PDFs with printer/copies/paper/orientation/duplex
  options. Whether a setting is honoured depends on the printer driver.

## Run

```bash
npm ci
npm start            # listens on 127.0.0.1:7777 by default
```

Point the backend at it, e.g. `PRINTER_AGENT_URL=http://127.0.0.1:7777`
(plus `PRINTER_AGENT_TOKEN` if you set one).

## Security

- Binds to `127.0.0.1` by default.
- With `PRINTER_AGENT_TOKEN` set, every request (except `/health`) needs a
  matching `x-printer-agent-token` header (constant-time comparison);
  otherwise only loopback callers are accepted.
- Requests carrying a browser `Origin` header are refused unless listed in
  `PRINTER_AGENT_ALLOWED_ORIGINS`, so a web page open on the shop computer
  cannot call this loopback service.
- Only PDFs are accepted for printing. The document is written to a temp file
  for spooling and deleted afterwards; it is never logged.

## Tests

```bash
npm test        # validation + HTTP guard tests; discovery test runs on Windows only
```
