// Windows printer provider for the Inklink local printer agent.
//
// This is the ONLY platform-specific module. Generic validation lives in
// printConfig.js and HTTP/auth in index.js, so another provider (e.g. CUPS on
// Linux, or a bridge to an ESP32-S3 device controller) can be added beside it.
//
// Discovery + availability come from the Windows print subsystem via a
// PowerShell SCRIPT FILE (scripts/discover-printers.ps1) — never an inline
// command string (inline `$_` gets mangled by shell quoting).
//
// Submission uses the `pdf-to-printer` package, which bundles SumatraPDF and
// spools a PDF to a named printer with copies/paper/orientation/duplex where
// the driver supports them. We map our validated config to its options.
//
// HONESTY:
//   - We never fabricate a printer. Discovery returns exactly what the OS lists.
//   - We never claim physical completion. A successful submit means the job was
//     accepted by the Windows spooler, which is NOT the same as paper printed.
//   - Capabilities we cannot confirm (duplex/color support) are reported null.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISCOVER_SCRIPT = path.join(__dirname, '..', 'scripts', 'discover-printers.ps1');

export class PrinterAgentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Run a PowerShell script file and resolve its stdout. Rejects on failure. */
function runPowerShellFile(scriptPath, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      ps.kill();
      reject(new PrinterAgentError('DISCOVERY_TIMEOUT', 'Printer discovery timed out.'));
    }, timeoutMs);
    ps.stdout.on('data', (d) => (stdout += d.toString()));
    ps.stderr.on('data', (d) => (stderr += d.toString()));
    ps.on('error', (err) => {
      clearTimeout(timer);
      reject(new PrinterAgentError('POWERSHELL_UNAVAILABLE', err.message));
    });
    ps.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new PrinterAgentError('DISCOVERY_FAILED', stderr.trim() || `exit ${code}`));
    });
  });
}

/**
 * Discover printers from the Windows print subsystem.
 * @returns {Promise<{ printers: Array, defaultPrinter: string|null }>}
 */
export async function discoverPrinters() {
  if (os.platform() !== 'win32') {
    // Honest: this provider only implements Windows. Other OSes are unsupported
    // here (a CUPS provider would be a separate implementation).
    throw new PrinterAgentError(
      'UNSUPPORTED_OS',
      `This local printer agent supports Windows only (detected ${os.platform()}).`,
    );
  }
  const raw = await runPowerShellFile(DISCOVER_SCRIPT);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PrinterAgentError('DISCOVERY_PARSE_FAILED', 'Could not parse printer discovery output.');
  }
  // Normalize: PowerShell emits a single object; ensure an array of printers.
  const printers = Array.isArray(parsed.printers)
    ? parsed.printers
    : parsed.printers
      ? [parsed.printers]
      : [];
  return { printers, defaultPrinter: parsed.defaultPrinter ?? null };
}

/** Find a specific printer by id, or null. */
export async function findPrinter(printerId) {
  const { printers } = await discoverPrinters();
  return printers.find((p) => p.id === printerId) || null;
}

/**
 * Submit a PDF to a printer with the given validated config. Returns a
 * structured result. A success means the SPOOLER ACCEPTED the job, not that
 * paper physically printed.
 *
 * @param {Buffer} pdfBytes
 * @param {object} config validated config (printerId, copies, colorMode, paperSize, orientation, sides)
 * @returns {Promise<{ ok: boolean, state: string, message: string, submissionId?: string }>}
 */
export async function submitPrintJob(pdfBytes, config) {
  // Confirm the printer still exists and is available right now.
  const printer = await findPrinter(config.printerId);
  if (!printer) {
    return { ok: false, state: 'PRINTER_NOT_FOUND', message: `Printer "${config.printerId}" was not found.` };
  }
  if (printer.status === 'offline') {
    return { ok: false, state: 'PRINTER_UNAVAILABLE', message: `Printer "${config.printerId}" is offline.` };
  }

  // Lazy-load the submit library so discovery works even if it is missing.
  let printLib;
  try {
    printLib = await import('pdf-to-printer');
  } catch {
    return {
      ok: false,
      state: 'SUBMIT_UNAVAILABLE',
      message:
        'Print submission library is not installed on the local agent, so jobs cannot be spooled. ' +
        'Discovery and availability still work.',
    };
  }
  const print = printLib.print || printLib.default?.print;
  if (typeof print !== 'function') {
    return { ok: false, state: 'SUBMIT_UNAVAILABLE', message: 'Print submission is unavailable on this agent.' };
  }

  // Write the PDF to a temp file (the lib spools from a path).
  const tmp = path.join(os.tmpdir(), `inklink_${crypto.randomUUID()}.pdf`);
  await fs.writeFile(tmp, pdfBytes);
  try {
    // Map our validated config to pdf-to-printer options. Only pass options the
    // library understands; the OS/driver decides what it can honour.
    const options = {
      printer: config.printerId,
      copies: config.copies,
      // win32 options for SumatraPDF: orientation + paper + color + duplex.
      win32: [
        `-print-settings`,
        [
          config.orientation === 'landscape' ? 'landscape' : 'portrait',
          config.colorMode === 'monochrome' ? 'monochrome' : 'color',
          config.sides === 'one-sided'
            ? 'simplex'
            : config.sides === 'two-sided-short-edge'
              ? 'duplexshort'
              : 'duplex',
        ].join(','),
      ],
      paperSize: config.paperSize,
    };
    await print(tmp, options);
    return {
      ok: true,
      state: 'PRINT_SUBMITTED',
      message:
        'Print job accepted by the Windows spooler. Physical completion is not observable, so this ' +
        'is reported as submitted, not printed.',
      // Agent-generated reference for this submission. It is NOT a Windows
      // spooler job id (pdf-to-printer does not return one), so it cannot be
      // used to query or cancel the spooled job.
      submissionId: `sub_${crypto.randomUUID()}`,
    };
  } catch (err) {
    return {
      ok: false,
      state: 'SUBMIT_FAILED',
      message: `The printer rejected the job or submission failed: ${String(err?.message || err).slice(0, 300)}`,
    };
  } finally {
    // Best-effort temp cleanup; never throw from cleanup.
    fs.unlink(tmp).catch(() => {});
  }
}
