// Inklink Local Printer Agent — runs on the print shop's computer.
//
// ROLE: a local printer ADAPTER / gateway component. A browser and a cloud or
// container backend cannot reliably control a local USB/network printer; this
// small local service is the trust boundary that can. The Inklink backend calls
// it over localhost (or the shop LAN) to discover printers, check availability,
// validate a configuration, and submit an APPROVED job.
//
// This is NOT ESP32 firmware. It drives printers through the Windows print
// spooler. ESP32-S3 device integration is a separate component and must not be
// mixed into this adapter.
//
// SECURITY:
//   - Binds to 127.0.0.1 by default (localhost only).
//   - Optional shared token (PRINTER_AGENT_TOKEN), compared in constant time.
//   - Requests that carry a browser Origin header are refused unless that
//     origin is explicitly allowlisted. Without this, any web page open on the
//     shop computer could call this loopback service.
//   - Exposes ONLY these allowlisted operations. There is NO generic shell or
//     "run command" endpoint. Nothing from a request is executed as a command.
//   - The PDF to print arrives as base64 in the submit body; it must start with
//     the PDF signature, is written to a temp file, spooled, and deleted.
//     Document bytes are never logged.

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { discoverPrinters, findPrinter, submitPrintJob, PrinterAgentError } from './windowsPrinter.js';
import { validatePrintConfig } from './printConfig.js';

const PORT = parseInt(process.env.PRINTER_AGENT_PORT ?? '7777', 10);
const HOST = process.env.PRINTER_AGENT_HOST ?? '127.0.0.1';
const TOKEN = (process.env.PRINTER_AGENT_TOKEN ?? '').trim(); // optional shared secret
const MAX_PDF_BYTES = parseInt(process.env.PRINTER_AGENT_MAX_PDF_BYTES ?? String(50 * 1024 * 1024), 10);
const ALLOWED_ORIGINS = (process.env.PRINTER_AGENT_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PDF_SIGNATURE = Buffer.from('%PDF-');

/** Constant-time token comparison (avoids leaking the token via timing). */
function tokenMatches(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const app = express();

// CORS only for explicitly allowlisted origins (none by default). The Inklink
// backend calls this service server-to-server and needs no CORS.
if (ALLOWED_ORIGINS.length > 0) {
  app.use(cors({ origin: ALLOWED_ORIGINS }));
}
app.use(express.json({ limit: '80mb' })); // base64 PDF inflates ~33%

// Browser-origin guard. Server-to-server callers do not send an Origin header;
// browsers always do for cross-origin fetches. Refuse unknown origins on every
// route except /health so a web page cannot drive the printer.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const origin = req.get('origin');
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({
      error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Browser requests from this origin are not allowed.' },
    });
  }
  return next();
});

// Shared-token auth. If PRINTER_AGENT_TOKEN is set, every request must carry it
// as `x-printer-agent-token`. If unset, we only accept loopback connections.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (TOKEN) {
    if (!tokenMatches(req.get('x-printer-agent-token'))) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing agent token.' } });
    }
    return next();
  }
  const ip = req.ip || req.socket.remoteAddress || '';
  if (isLoopback(ip)) return next();
  return res.status(401).json({
    error: { code: 'UNAUTHORIZED', message: 'Non-local request rejected (set PRINTER_AGENT_TOKEN to allow).' },
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', service: 'inklink-local-printer-agent', platform: process.platform });
});

/** GET /printers — real discovery. */
app.get('/printers', async (_req, res) => {
  try {
    const { printers, defaultPrinter } = await discoverPrinters();
    res.json({ ok: true, printers, defaultPrinter });
  } catch (err) {
    const code = err instanceof PrinterAgentError ? err.code : 'DISCOVERY_FAILED';
    res.status(502).json({ ok: false, error: { code, message: 'Printer discovery failed.' } });
  }
});

/** GET /printers/:id/availability — is this specific printer available now? */
app.get('/printers/:id/availability', async (req, res) => {
  try {
    const printer = await findPrinter(req.params.id);
    if (!printer) {
      return res.json({ ok: true, available: false, status: 'not_found' });
    }
    res.json({ ok: true, available: printer.status !== 'offline', status: printer.status, printer });
  } catch (err) {
    const code = err instanceof PrinterAgentError ? err.code : 'DISCOVERY_FAILED';
    res.status(502).json({ ok: false, error: { code, message: 'Availability check failed.' } });
  }
});

/** POST /validate — validate a proposed config against discovered printers. */
app.post('/validate', async (req, res) => {
  try {
    const { printers } = await discoverPrinters();
    const result = validatePrintConfig(req.body?.config, printers);
    res.json(result);
  } catch (err) {
    const code = err instanceof PrinterAgentError ? err.code : 'DISCOVERY_FAILED';
    res.status(502).json({ ok: false, errors: ['Could not validate against discovered printers.'], code });
  }
});

/**
 * POST /print — submit an APPROVED job.
 * Body: { config: {...}, documentBase64: string }
 * The Inklink backend is responsible for enforcing customer approval, payment
 * and shop approval BEFORE calling this. This adapter does not track job state.
 */
app.post('/print', async (req, res) => {
  const { config, documentBase64 } = req.body || {};
  if (typeof documentBase64 !== 'string' || documentBase64.length === 0) {
    return res.status(400).json({ ok: false, state: 'BAD_REQUEST', message: 'documentBase64 is required.' });
  }
  const pdfBytes = Buffer.from(documentBase64, 'base64');
  if (pdfBytes.length === 0 || pdfBytes.length > MAX_PDF_BYTES) {
    return res.status(400).json({ ok: false, state: 'BAD_REQUEST', message: 'Document is empty or too large.' });
  }
  if (!pdfBytes.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    return res.status(400).json({ ok: false, state: 'BAD_REQUEST', message: 'Only PDF documents can be printed.' });
  }

  try {
    // Re-validate the config against currently discovered printers — never
    // trust the caller to have validated, and never execute anything from text.
    let printers = [];
    try {
      ({ printers } = await discoverPrinters());
    } catch {
      return res
        .status(502)
        .json({ ok: false, state: 'PRINTER_ADAPTER_UNAVAILABLE', message: 'Printer discovery failed; cannot submit.' });
    }
    const v = validatePrintConfig(config, printers);
    if (!v.ok) {
      return res.status(400).json({ ok: false, state: 'INVALID_CONFIG', message: 'Invalid print configuration.', errors: v.errors });
    }

    const result = await submitPrintJob(pdfBytes, v.value);
    return res.status(result.ok ? 200 : 502).json(result);
  } catch (err) {
    // e.g. discovery failing during submitPrintJob's re-check. Never crash the
    // process on a single request; report a clean adapter failure.
    const code = err instanceof PrinterAgentError ? err.code : 'SUBMIT_FAILED';
    return res.status(502).json({ ok: false, state: 'PRINTER_ADAPTER_UNAVAILABLE', code, message: 'Print submission failed.' });
  }
});

// Final error handler (malformed JSON, oversized bodies, unexpected throws).
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err?.type === 'entity.too.large' ? 413 : err?.type === 'entity.parse.failed' ? 400 : 500;
  res.status(status).json({ ok: false, state: 'BAD_REQUEST', message: status === 500 ? 'Internal agent error.' : 'Malformed request.' });
});

export function start() {
  return app.listen(PORT, HOST, () => {
    // Never log document contents or secrets.
    // eslint-disable-next-line no-console
    console.log(`[inklink-printer-agent] listening on http://${HOST}:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[inklink-printer-agent] token auth: ${TOKEN ? 'enabled' : 'disabled (localhost-only)'}`);
  });
}

// Start only when run directly (`node src/index.js`), so tests can import the app.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) start();

export default app;
