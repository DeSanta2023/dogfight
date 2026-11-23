# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------------------------
# Two stages. The first one has everything needed to BUILD (vite, all dev dependencies, the
# sources of the client). The second one only has what is needed to RUN: production dependencies
# of the server, the server and shared sources, and the built client. Nothing from stage 1
# except client/dist reaches the final image, which is why it is small and has no dev tools.
# ---------------------------------------------------------------------------------------------
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
# Dependency manifests first: this layer is rebuilt only when a package.json or the lockfile changes.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared shared
COPY client client
RUN npm run build --workspace client

# ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
# The commit this image was built from (CI passes --build-arg GIT_SHA=...); /health shows it.
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_DIR=/app/logs \
    # The image is meant to run behind the platform's TLS proxy (every host has one), where the
    # real client address is in X-Forwarded-For. Run it directly on the internet with -e TRUST_PROXY=0.
    TRUST_PROXY=1 \
    GIT_SHA=${GIT_SHA}
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
# Production dependencies of the server only (ws, zod, pino): no vite, no vitest, no playwright.
# Then remove npm itself: the container never installs anything, and it is ~20 MB.
RUN npm ci --omit=dev --workspace server \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* \
 && mkdir -p /app/logs && chown node:node /app/logs

COPY shared/src shared/src
COPY server server
COPY --from=build /app/client/dist client/dist

# Not root: if someone breaks out of the Node process, they are the unprivileged user `node`.
USER node
EXPOSE 3000

# Compose and `docker ps` show "healthy"/"unhealthy". Node does the request: alpine has no curl.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# `node file`, NOT `npm start`: with npm in between, SIGTERM from `docker stop` goes to npm, which
# does not pass it on, and after 10 s Docker kills the game with SIGKILL (players get no goodbye,
# logs are not flushed). Exec form (a JSON array) makes node PID 1, so it receives the signal itself.
STOPSIGNAL SIGTERM
CMD ["node", "server/index.ts"]
