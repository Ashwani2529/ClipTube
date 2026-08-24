import type { ErrorRequestHandler, RequestHandler } from 'express';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    // The response is already streaming (e.g. a file download) — let Express tear it down.
    next(error);
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, details: error.details ?? undefined });
    return;
  }

  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ error: 'Request body is not valid JSON.' });
    return;
  }

  logger.error('Unhandled request error', error);
  res.status(500).json({ error: 'Something went wrong on the server.' });
};
