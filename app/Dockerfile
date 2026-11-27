# ---- build the SPA -----------------------------------------------------------
# The build context is the repository root (see docker-compose.yml) so the image
# can also carry gallery/build.mjs and scripts/migrate-scenes.mjs — the two
# tools the entrypoint runs at boot so a bare `docker compose up` is enough.
FROM node:24-bookworm-slim AS build

WORKDIR /app

# NODE_ENV=production is sometimes inherited from the shell; vite lives in
# devDependencies, so ask for them explicitly.
ENV NODE_ENV=development

COPY app/package.json app/package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY app/index.html app/vite.config.mjs ./
COPY app/public ./public
COPY app/src ./src
RUN npm run build

# write .br/.gz next to every text asset now, so the runtime never brotli-
# compresses the 1.5MB entry bundle on a request
COPY app/server.mjs ./server.mjs
RUN node server.mjs --precompress dist

# ---- runtime -----------------------------------------------------------------
FROM node:24-bookworm-slim

# stamped by `docker compose build --build-arg BUILD_COMMIT=$(git rev-parse
# --short HEAD) --build-arg BUILD_DATE=$(date -u +%F)`; /api/health reports them
# so a container serving an old build is visible instead of guessed at
ARG BUILD_COMMIT=dev
ARG BUILD_DATE=dev

ENV NODE_ENV=production \
    PORT=5002 \
    APP_DIR=/srv/dist \
    DATA_DIR=/data \
    GALLERY_DIR=/gallery \
    GALLERY_BUILD=/srv/tools/build.mjs \
    LOGO_DIR=/srv/assets/logo \
    BUILD_COMMIT=${BUILD_COMMIT} \
    BUILD_DATE=${BUILD_DATE}

WORKDIR /srv
COPY app/server.mjs ./
COPY --from=build /app/dist ./dist
# the websocket server needs `ws`; it ships without dependencies of its own, so
# copying the one folder keeps the runtime image from carrying the whole tree
COPY --from=build /app/node_modules/ws ./node_modules/ws

# boot-time helpers: migrate legacy boards, then write the catalogue
COPY docker/entrypoint.sh /srv/entrypoint.sh
COPY gallery/build.mjs /srv/tools/build.mjs
COPY scripts/migrate-scenes.mjs /srv/tools/migrate-scenes.mjs
COPY assets/logo /srv/assets/logo

# files written by tools that default to 0600 would not be readable by an
# unprivileged runtime user, which is how the container is normally started
RUN mkdir -p /data /gallery && chmod -R a+rX /srv && chmod +x /srv/entrypoint.sh

EXPOSE 5002

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5002)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/srv/entrypoint.sh"]
CMD ["node", "server.mjs"]
