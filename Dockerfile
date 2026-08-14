# ─── Build stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ─── Production deps only ───────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ─── Runtime stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Run as a non-root user.
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# migrate-mongo config + migrations ship in the image so releases can migrate before rollout.
COPY migrate-mongo-config.js ./
COPY migrations ./migrations
USER app
EXPOSE 8080
# Default: API + Socket.IO. Override the command to `node dist/worker.js` for the worker dyno.
CMD ["node", "dist/server.js"]
