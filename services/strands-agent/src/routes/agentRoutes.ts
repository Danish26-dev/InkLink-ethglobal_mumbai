/**
 * Agent HTTP routes.
 *
 * The Inklink backend calls these. The primary endpoint is /api/edit which
 * takes a multipart upload (the document + the natural-language instruction)
 * and returns the agent's validated plan, the Document Engine result and any
 * print-option proposal. The response is a proposal only; the backend owns
 * approval, payment and job status.
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { documentEngine } from '../clients/documentEngineClient.js';
import { planningOrchestrator } from '../services/orchestrator.js';
import { AgentError, toAgentError } from '../errors.js';
import { SUPPORTED_OPERATIONS } from '../types.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  const engineUp = await documentEngine.health();
  res.json({
    status: 'healthy',
    service: 'inklink-strands-agent',
    documentEngineReachable: engineUp,
    supportedOperations: SUPPORTED_OPERATIONS,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/edit
 * multipart form:
 *   file        - the .docx or .pdf
 *   instruction - natural language instruction
 */
router.post('/edit', upload.single('file'), async (req: Request, res: Response) => {
  const instruction = (req.body?.instruction ?? '').toString().trim();
  const file = req.file;

  if (!file) {
    res.status(400).json({ error: { code: 'missing_file', message: 'A document file is required.' } });
    return;
  }
  if (!instruction) {
    res.status(400).json({ error: { code: 'missing_instruction', message: 'An instruction is required.' } });
    return;
  }

  try {
    const result = await planningOrchestrator.runEdit({
      instruction,
      fileBuffer: file.buffer,
      filename: file.originalname || 'upload',
    });
    res.json({ success: true, result });
  } catch (err: unknown) {
    const agentErr: AgentError = err instanceof AgentError ? err : toAgentError(err);
    // Log only the non-secret code + safe detail. Never log credentials or the
    // raw error object (which could contain request/signing metadata).
    // eslint-disable-next-line no-console
    console.error(`[inklink-agent] ${agentErr.code}${agentErr.logDetail ? ` (${agentErr.logDetail})` : ''}`);
    // Choose an HTTP status: config/auth problems are 500/502-ish; keep 502 for
    // upstream AI failures so the Backend can distinguish them.
    const status = agentErr.code === 'AGENT_MISCONFIGURED' ? 500 : 502;
    res.status(status).json({ error: { code: agentErr.code, message: agentErr.message } });
  }
});

export default router;
