import type { ErrorRequestHandler } from 'express';
import multer from 'multer';

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const status = error instanceof HttpError ? error.status : error instanceof multer.MulterError ? 400 : 500;
  if (status >= 500) console.error(error);

  res.status(status).json({
    error: status >= 500 && process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
  });
};
