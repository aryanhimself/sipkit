# sipkit push service (Web Push / VAPID). Build context: services/push
#   docker build -t sipkit/push:dev services/push
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8790 \
    PUSH_STORE_FILE=/data/subscriptions.json
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8790
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1

CMD ["node", "--experimental-strip-types", "--no-warnings=ExperimentalWarning", "src/main.ts"]
