import type { Request, Response, NextFunction } from 'express';

/**
 * Last-resort error handler. Raw error messages can contain internal details
 * (paths, upstream responses), so they are logged by name only and the client
 * receives a stable, generic body. Upload-limit errors from multer keep their
 * specific code because they are safe and actionable.
 */
export const errorHandler = (
  err: Error & { code?: string },
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: { code: 'file_too_large', message: 'The document exceeds the upload limit.' } });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`[inklink-agent] unhandled error: ${err?.name ?? 'Error'}`);
  res.status(500).json({
    error: {
      code: 'agent_error',
      message: 'The document assistant hit an internal error.',
      timestamp: new Date().toISOString(),
    },
  });
};
