FROM node:24-bookworm-slim

WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev --no-audit --no-fund --prefix server

COPY --chown=node:node server/src ./server/src
COPY --chown=node:node scripts/reconcile-checkpoint-rewards.mjs ./scripts/
COPY --chown=node:node shared ./shared
COPY --chown=node:node config ./config
COPY --chown=node:node deployments/testnet.config.json ./deployments/testnet.config.json
COPY --chown=node:node expedition-*.mjs ./

ENV NODE_ENV=production VEILBOUND_BIND=0.0.0.0 VEILBOUND_PORT=8787 VEILBOUND_DATA_DIR=/app/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:' + process.env.VEILBOUND_PORT + '/health').then(r => { if (!r.ok) process.exitCode = 1 }).catch(() => { process.exitCode = 1 })"
CMD ["sh", "-ec", "install -d -o node -g node -m 0750 \"$VEILBOUND_DATA_DIR\"; chown node:node \"$VEILBOUND_DATA_DIR\"; exec runuser -u node -- node server/src/main.mjs"]
