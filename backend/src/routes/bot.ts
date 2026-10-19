import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../middleware/asyncHandler';
import { botAuth } from '../middleware/botAuth';
import { botCategories, createBotArticle, getBotArticle, publishBotArticle, saveBotArticleImage } from '../services/botArticleStore';
import { HttpError } from '../middleware/errorHandler';

export const botRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 } });

botRouter.use(botAuth);
botRouter.get('/options/', (_req, res) => res.json({ version: 1, site: 'sorenwinslow', categories: botCategories, authors: [] }));
botRouter.post('/articles/', asyncHandler(async (req, res) => res.status(201).json(createBotArticle(req.body))));
botRouter.get('/articles/:externalId/', asyncHandler(async (req, res) => {
  const article = getBotArticle(req.params.externalId);
  if (!article) throw new HttpError(404, 'Article not found');
  res.json(article);
}));
botRouter.put('/articles/:externalId/image/', upload.single('image'), asyncHandler(async (req, res) => {
  res.json(await saveBotArticleImage(req.params.externalId, req.file?.buffer));
}));
botRouter.post('/articles/:externalId/publish/', asyncHandler(async (req, res) => res.json(publishBotArticle(req.params.externalId))));
