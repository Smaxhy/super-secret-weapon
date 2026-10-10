# ---------- Build stage: compile TypeScript ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# openssl is needed by Prisma's query engine
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate && npm run build && npm prune --omit=dev

# ---------- Runtime stage: just what's needed to run ----------
FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/schema.prisma ./src/db/schema.prisma
COPY package.json ./
# Last, so a new commit doesn't invalidate the cached layers above.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
# Sync the DB schema, then start. `db push` is idempotent — safe on every boot.
# `exec` makes node PID 1: Docker's SIGTERM reaches the bot, so updates shut it down cleanly
# (without it sh swallowed the signal, the bot was SIGKILLed after 20 s and every update looked like a crash).
CMD ["sh", "-c", "npx prisma db push --skip-generate && exec node dist/index.js"]
