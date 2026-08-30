# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
# The npm download cache persists across image builds in a BuildKit-managed
# volume, so dependency changes re-fetch only what moved and CI's multi-arch
# build stops re-downloading the whole tree on every platform.
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Reduce to production dependencies only.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev && npm cache clean --force

# ---------- runtime ----------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# iputils-ping provides the `ping` binary used by ICMP monitors.
RUN apt-get update \
 && apt-get install -y --no-install-recommends iputils-ping ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
