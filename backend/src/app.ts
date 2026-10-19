import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'path';
import { errorHandler } from './middleware/errorHandler';
import { postsRouter } from './routes/posts';
import { subscribersRouter } from './routes/subscribers';
import { authRouter } from './routes/auth';
import { adminRouter } from './routes/admin';
import { aiRouter } from './routes/ai';
import { healthIndexRouter } from './routes/healthIndex';
import { botRouter } from './routes/bot';

export function createApp() {
  const app = express();
  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: corsOrigin, credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/uploads', express.static(process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads')));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'sorenwinslow-backend', time: new Date().toISOString() }));
  app.use('/api/bot/v1', botRouter);
  app.use('/api/posts', postsRouter);
  app.use('/api/subscribe', subscribersRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/health-index', healthIndexRouter);
  app.use(errorHandler);
  return app;
}
