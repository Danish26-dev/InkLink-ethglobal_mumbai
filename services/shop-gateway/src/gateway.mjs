/**
 * Inklink shop gateway connector.
 *
 * Runs on the shop computer, next to the local printer adapter. It connects a
 * cloud-hosted Inklink backend (PRINTER_MODE=relay) to the printer WITHOUT exposing
 * anything on the shop network to the internet: every connection is OUTBOUND.
 *
 *   backend  <── HTTPS long-poll ──  shop gateway  ── HTTP (loopback) ──▶  printer adapter :7777
 *                                         │
 *                                         └── GET /display (LAN/loopback) ◀── ESP32-S3 status display
 *
 * Only the printer adapter's allowlisted operations are executed. A print request
 * carries a short-lived document reference; the PDF is downloaded from the backend
 * with the gateway token and handed to the adapter as before.
 */

import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const ALLOWED = [
  ['GET', /^\/printers$/],
  ['GET', /^\/printers\/[^/]+\/availability$/],
  ['POST', /^\/validate$/],
  ['POST', /^\/print$/],
];
const DOCUMENT_PATH = /^\/api\/v1\/gateway\/documents\/[A-Za-z0-9_-]{16,128}$/;
const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;
const MAX_DISPLAY_JOBS = 10;

export function loadConfig(env = process.env) {
  const cfg = {
    backendUrl: (env.BACKEND_URL ?? '').trim().replace(/\/+$/, ''),
    gatewayToken: (env.GATEWAY_TOKEN ?? '').trim(),
    gatewayId: (env.GATEWAY_ID ?? 'gateway_001').trim(),
    printerAgentUrl: (env.PRINTER_AGENT_URL ?? 'http://127.0.0.1:7777').trim().replace(/\/+$/, ''),
    printerAgentToken: (env.PRINTER_AGENT_TOKEN ?? '').trim(),
    pollWaitSeconds: Math.min(25, Math.max(1, Number(env.POLL_WAIT_SECONDS ?? 25) || 25)),
    displayHost: (env.DISPLAY_HOST ?? '127.0.0.1').trim(),
    displayPort: Number(env.DISPLAY_PORT ?? 7780) || 7780,
    displayToken: (env.DISPLAY_TOKEN ?? '').trim(),
  };
  const missing = [];
  if (!cfg.backendUrl) missing.push('BACKEND_URL');
  if (!cfg.gatewayToken) missing.push('GATEWAY_TOKEN');
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}`);
  const backend = new URL(cfg.backendUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname);
  if (backend.protocol !== 'https:' && !loopback && env.ALLOW_INSECURE_BACKEND !== '1') {
    throw new Error('BACKEND_URL must use https (set ALLOW_INSECURE_BACKEND=1 only for a LAN test backend)');
  }
  return cfg;
}

export function isAllowed(method, path) {
  return ALLOWED.some(([m, re]) => m === method && re.test(path));
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export function createGateway(cfg, { fetchImpl = fetch, log = console } = {}) {
  const state = {
    connected: false,
    lastPollAt: null,
    lastError: null,
    jobs: new Map(), // jobId -> display status
  };
  let running = false;
  let currentAbort = null;
  const backendHeaders = {
    authorization: `Bearer ${cfg.gatewayToken}`,
    'content-type': 'application/json',
  };

  function applyEvents(events) {
    for (const e of events ?? []) {
      if (!e || typeof e.jobId !== 'string') continue;
      const prev = state.jobs.get(e.jobId) ?? { jobId: e.jobId };
      const p = e.payload ?? {};
      const next = {
        ...prev,
        ...(typeof p.status === 'string' ? { status: p.status } : {}),
        ...(typeof p.paymentStatus === 'string' ? { paymentStatus: p.paymentStatus } : {}),
        ...(typeof p.deviceStatus === 'string' ? { deviceStatus: p.deviceStatus } : {}),
        ...(e.type === 'execution_authorized' ? { authorized: true } : {}),
        updatedAt: e.ts ?? new Date().toISOString(),
      };
      state.jobs.delete(e.jobId); // re-insert so the most recent job is last
      state.jobs.set(e.jobId, next);
    }
    // Keep the newest few only; the gateway holds status, never documents.
    while (state.jobs.size > MAX_DISPLAY_JOBS) state.jobs.delete(state.jobs.keys().next().value);
  }

  async function downloadDocument(ref) {
    if (!ref || typeof ref.path !== 'string' || !DOCUMENT_PATH.test(ref.path)) {
      throw Object.assign(new Error('Invalid document reference.'), { code: 'INVALID_DOCUMENT_REFERENCE' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetchImpl(`${cfg.backendUrl}${ref.path}`, {
        headers: { authorization: backendHeaders.authorization },
        signal: controller.signal,
      });
      if (res.status !== 200) {
        throw Object.assign(new Error(`Document download failed (${res.status}).`), { code: 'DOCUMENT_UNAVAILABLE' });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_DOCUMENT_BYTES) {
        throw Object.assign(new Error('Document size is out of range.'), { code: 'DOCUMENT_UNAVAILABLE' });
      }
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Execute one relayed request against the local adapter -> {id, status, body}. */
  async function handleRequest(req) {
    const method = String(req?.method ?? '').toUpperCase();
    const path = String(req?.path ?? '');
    if (!isAllowed(method, path)) {
      return { id: req?.id, status: 403, body: { ok: false, error: { code: 'POLICY_VIOLATION', message: 'Operation not allowed by the shop gateway.' } } };
    }
    let body = req.body ?? null;
    try {
      if (method === 'POST' && path === '/print') {
        const pdf = await downloadDocument(body?.document);
        body = { config: body?.config, documentBase64: pdf.toString('base64') };
      }
      const headers = { 'content-type': 'application/json' };
      if (cfg.printerAgentToken) headers['x-printer-agent-token'] = cfg.printerAgentToken;
      const out = await fetchJson(
        fetchImpl,
        `${cfg.printerAgentUrl}${path}`,
        { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) },
        path === '/print' ? 120_000 : 20_000,
      );
      return { id: req.id, status: out.status, body: out.body };
    } catch (err) {
      const code = err?.code && typeof err.code === 'string' && !err.code.startsWith('ERR_') ? err.code : 'PRINTER_ADAPTER_UNREACHABLE';
      const message = code === 'PRINTER_ADAPTER_UNREACHABLE' ? 'The local printer adapter is not reachable.' : err.message;
      return { id: req.id, status: 502, body: { ok: false, error: { code, message } } };
    }
  }

  async function postResults(results) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const out = await fetchJson(fetchImpl, `${cfg.backendUrl}/api/v1/gateway/results`,
          { method: 'POST', headers: backendHeaders, body: JSON.stringify({ results }) }, 15_000);
        if (out.status === 200) return true;
        if (out.status === 401 || out.status === 404) break; // misconfigured: retrying does not help
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    log.warn?.('[shop-gateway] could not deliver results to the backend');
    return false;
  }

  /** One long-poll round. Returns true on success. */
  async function pollOnce() {
    currentAbort = new AbortController();
    const timer = setTimeout(() => currentAbort.abort(), (cfg.pollWaitSeconds + 20) * 1000);
    let out;
    try {
      const res = await fetchImpl(`${cfg.backendUrl}/api/v1/gateway/poll`, {
        method: 'POST',
        headers: backendHeaders,
        body: JSON.stringify({ gatewayId: cfg.gatewayId, maxWaitSeconds: cfg.pollWaitSeconds }),
        signal: currentAbort.signal,
      });
      out = { status: res.status, body: await res.json().catch(() => null) };
    } catch (err) {
      state.connected = false;
      state.lastError = 'backend unreachable';
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (out.status !== 200 || !out.body) {
      state.connected = false;
      state.lastError = `backend returned ${out.status}`;
      throw Object.assign(new Error(state.lastError), { status: out.status });
    }
    state.connected = true;
    state.lastError = null;
    state.lastPollAt = new Date().toISOString();
    applyEvents(out.body.events);
    const requests = Array.isArray(out.body.requests) ? out.body.requests : [];
    if (requests.length) {
      // Answer each request as soon as it completes (a slow print never delays discovery).
      await Promise.all(requests.map(async (r) => postResults([await handleRequest(r)])));
    }
    return true;
  }

  async function run() {
    running = true;
    let failures = 0;
    log.log?.(`[shop-gateway] ${cfg.gatewayId} -> ${cfg.backendUrl} (printer adapter ${cfg.printerAgentUrl})`);
    while (running) {
      try {
        await pollOnce();
        if (failures) log.log?.('[shop-gateway] connected to the backend');
        failures = 0;
      } catch (err) {
        if (!running) break;
        failures += 1;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)) * (0.75 + Math.random() * 0.5);
        if (failures === 1 || failures % 10 === 0) {
          log.warn?.(`[shop-gateway] ${state.lastError ?? err.message}; retrying in ${Math.round(delay / 1000)}s`);
        }
        if (err?.status === 401) log.warn?.('[shop-gateway] GATEWAY_TOKEN was rejected by the backend');
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  function stop() {
    running = false;
    currentAbort?.abort();
  }

  function displayState() {
    return {
      gatewayId: cfg.gatewayId,
      backendConnected: state.connected,
      lastPollAt: state.lastPollAt,
      jobs: [...state.jobs.values()].reverse(),
    };
  }

  /** Read-only status endpoint for the ESP32-S3 display (loopback/LAN only). */
  function createDisplayServer() {
    return http.createServer((req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'GET') return send(405, { ok: false });
      if (req.url === '/health') return send(200, { ok: true, backendConnected: state.connected });
      if (req.url !== '/display') return send(404, { ok: false });
      if (cfg.displayToken) {
        const supplied = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
        if (!safeEqual(supplied, cfg.displayToken)) return send(401, { ok: false });
      }
      return send(200, displayState());
    });
  }

  return { state, handleRequest, pollOnce, run, stop, displayState, createDisplayServer, applyEvents };
}
