# syntax=docker/dockerfile:1
# One Dockerfile, two images: `server` (API and worker) and `web` (Next.js).
# compose.yaml builds both; see the README's "Run with Docker" section.

ARG NODE_VERSION=22

# ── Build everything once ─────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
RUN npm run build:server && npm run build:client

# ── API and worker ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS server
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace=server && npm cache clean --force
# The Direct provider renders pages in a local headless Chromium.
RUN npx playwright-core install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/server/dist server/dist
# data/ (sites, brands, catalogs, checkpoints) and storage/ (Excel files) are volumes.
RUN mkdir -p server/data server/storage/excel && chown -R node:node server/data server/storage
USER node
WORKDIR /app/server
EXPOSE 3001
CMD ["node", "dist/index.js"]

# ── Web ───────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/client/.next/standalone ./
COPY --from=build --chown=node:node /app/client/.next/static client/.next/static
COPY --from=build --chown=node:node /app/client/public client/public
USER node
EXPOSE 3000
CMD ["node", "client/server.js"]
