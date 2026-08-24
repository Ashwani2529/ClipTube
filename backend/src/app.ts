import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { env } from './config/env';
import { apiRouter } from './routes/api';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  app.use(
    cors({
      origin: env.corsOrigins.length > 0 ? env.corsOrigins : true,
      methods: ['GET', 'POST'],
    }),
  );

  // Requests are small JSON bodies only; nothing here accepts uploads.
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
