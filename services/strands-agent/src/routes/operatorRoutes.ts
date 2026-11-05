/**
 * Print Operator routes (called by the Inklink backend only).
 *
 * POST /api/operator/runs   multipart:
 *   file?        the job document (.pdf / .docx)
 *   instruction  natural-language instruction
 *   jobId        backend job id
 *   runId        backend-assigned run id
 *   defaults?    JSON Partial<OperatorPrintConfig> (shop defaults)
 *   current?     JSON Partial<OperatorPrintConfig> (already confirmed values)
 *
 * Response: `application/x-ndjson`, one HarnessEvent per line, streamed while
 * the run progresses. The stream always ends with an `agent_finished` event.
 *
 * Auth: `Authorization: Bearer <AGENT_SERVICE_TOKEN>`. Without a configured
 * token the endpoint refuses to run (it never runs unauthenticated).
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import type { HarnessEvent, OperatorPrintConfig } from '@inklink/shared-schemas';
import { runPrintOperator } from '../harness/operator.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const router = Router();

function authorized(req: Request): 'ok' | 'unconfigured' | 'denied' {
  const expected = (process.env.AGENT_SERVICE_TOKEN ?? '').trim();
  if (!expected) return 'unconfigured';
  const provided = /^Bearer (.+)$/i.exec(req.get('authorization') ?? '')?.[1] ?? '';
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return provided && crypto.timingSafeEqual(a, b) ? 'ok' : 'denied';
}

function parseConfig(raw: unknown): Partial<OperatorPrintConfig> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Partial<OperatorPrintConfig>) : {};
  } catch {
    return {};
  }
}

router.post('/runs', upload.single('file'), async (req: Request, res: Response) => {
  const auth = authorized(req);
  if (auth === 'unconfigured') {
    res.status(503).json({ error: { code: 'AGENT_NOT_CONFIGURED', message: 'AGENT_SERVICE_TOKEN is not configured.' } });
    return;
  }
  if (auth === 'denied') {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid service token.' } });
    return;
  }

  const instruction = String(req.body?.instruction ?? '').trim();
  const jobId = String(req.body?.jobId ?? '').trim();
  const runId = String(req.body?.runId ?? '').trim();
  if (!instruction || !/^[A-Za-z0-9_-]{1,64}$/.test(jobId) || !/^[A-Za-z0-9_-]{1,64}$/.test(runId)) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'instruction, jobId and runId are required.' } });
    return;
  }

  res.status(200);
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.flushHeaders?.();

  const emit = (event: HarnessEvent) => {
    if (!res.writableEnded) res.write(JSON.stringify(event) + '\n');
  };

  try {
    await runPrintOperator({
      jobId,
      runId,
      instruction,
      document: req.file ? { buffer: req.file.buffer, filename: req.file.originalname || 'document' } : null,
      defaults: parseConfig(req.body?.defaults),
      current: parseConfig(req.body?.current),
      emit,
    });
  } catch {
    emit({
      type: 'agent_finished',
      ts: new Date().toISOString(),
      payload: { runId, outcome: 'failed', message: 'The print operator stopped unexpectedly.' },
    });
  } finally {
    res.end();
  }
});

export default router;
