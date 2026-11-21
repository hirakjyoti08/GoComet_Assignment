# ---- build frontend ----
FROM node:24-alpine AS web
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- runtime: one container serves API + built SPA ----
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=4000 \
    STATIC_DIR=/app/frontend/dist \
    PGLITE_DIR=/data/pglite
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ ./
COPY --from=web /app/frontend/dist /app/frontend/dist
# /data is only used when no DATABASE_URL is set (embedded PGlite single-instance mode)
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://localhost:4000/api/health || exit 1
CMD ["node", "src/server.js"]
