# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && mkdir -p dist/dashboard/public && cp src/dashboard/public/index.html dist/dashboard/public/

# Stage 2: Runtime
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && \
    npx playwright install chrome --with-deps

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/webhook/server.js"]
