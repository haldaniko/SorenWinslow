FROM node:20-alpine AS base

WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci

FROM base AS dev

ENV NODE_ENV=development
COPY . .
EXPOSE 4000
CMD ["npm", "run", "dev"]

FROM base AS build

COPY . .
RUN npm run build

FROM node:20-alpine AS prod

WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tzdata su-exec
COPY package*.json ./
COPY --from=base /app/node_modules ./node_modules
RUN npm prune --omit=dev
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY sql ./sql
EXPOSE 4000
CMD ["npm", "run", "start"]
