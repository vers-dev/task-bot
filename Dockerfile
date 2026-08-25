# ---- build stage: compile TS → dist, build native deps (better-sqlite3) ----
FROM node:22-slim AS build
WORKDIR /app
# toolchain for native modules if a prebuilt binary is unavailable
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# drop devDeps but keep compiled native modules in node_modules
RUN npm prune --omit=dev

# ---- runtime stage: node_modules (with native binaries) + dist ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Build commit, passed by CI (--build-arg BUILD_SHA=…). Bot logs it on startup so you can
# verify which code is actually running in the container.
ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data
# Long-polling bot: outbound only, no ports exposed. SQLite at /app/data (volume).
CMD ["node", "dist/index.js"]
