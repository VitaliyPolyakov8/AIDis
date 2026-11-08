# AIDis backend image (Linux). Built on the server by `docker compose build` (deploy/setup.sh).

# ---- build stage -------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

# openssl is needed by the Prisma schema engine (migrations).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ---- runtime stage -----------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    UPLOAD_DIRECTORY=/app/storage/uploads \
    CLIENT_VERSION_FILE=/app/config/client-version.json \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    CHECKPOINT_DISABLE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./
COPY --chown=node:node config ./config

RUN mkdir -p /app/storage/uploads && chown -R node:node /app/storage

# Run as the unprivileged "node" user, never as root.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 1) apply pending migrations (non-destructive `migrate deploy`)
# 2) ensure default channels exist (idempotent)
# 3) start the server (exec so it receives SIGTERM directly)
CMD ["sh", "-c", "npx --no-install prisma migrate deploy && node dist/cli/seed.js && exec node dist/main.js"]
