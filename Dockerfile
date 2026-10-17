# syntax=docker/dockerfile:1.7

# ── build stage: install everything, build client + server ───────────────
FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ── runtime stage: production deps only, non-root ────────────────────────
FROM node:25-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    CLIENT_DIST=/app/client-dist
WORKDIR /app
# The server bundle inlines @couchbeam/shared; only ws + zod stay external.
RUN printf '{"name":"couchbeam-runtime","private":true,"type":"module"}' > package.json \
 && npm install --omit=dev --no-audit --no-fund ws@8 zod@3 \
 && npm cache clean --force
COPY --from=build /app/server/dist ./server-dist
COPY --from=build /app/client/dist ./client-dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# SESSION_SECRET is required in production and is deliberately NOT baked into the image.
CMD ["node", "server-dist/index.js"]
