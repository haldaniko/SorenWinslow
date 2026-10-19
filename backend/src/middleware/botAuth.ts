import { createHash, timingSafeEqual } from 'crypto';
import type { RequestHandler } from 'express';

export const botAuth: RequestHandler = (req, res, next) => {
  const expected = process.env.BOT_INTEGRATION_TOKEN?.trim() || '';
  const header = req.header('authorization') || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expectedHash = createHash('sha256').update(expected).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  if (!expected || !supplied || !timingSafeEqual(expectedHash, suppliedHash)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
};
