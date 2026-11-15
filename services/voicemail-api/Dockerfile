# voicemail-api: HTTP API over the Asterisk voicemail spool (V2-VM-02).
# Build context: services/voicemail-api (no runtime dependencies, only Node built-ins).
#
#   docker build -t sipkit/voicemail-api services/voicemail-api
#
# The container must run with the uid/gid that owns the spool (the Ubuntu
# asterisk package uses 100:101), see infra/asterisk/docker-compose.yml.
FROM node:22-alpine AS build
WORKDIR /app
RUN npm install --global --no-audit --no-fund typescript@5.7.3
COPY package.json tsconfig.json tsconfig.build.json ./
RUN npm install --no-save --no-audit --no-fund --no-package-lock @types/node@22.10.2
COPY src ./src
RUN tsc -p tsconfig.build.json

FROM node:22-alpine
ENV NODE_ENV=production PORT=8090 VM_SPOOL_DIR=/var/spool/asterisk/voicemail
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist ./dist
USER 100:101
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "dist/index.js"]
