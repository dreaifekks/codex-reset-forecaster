FROM node:22-alpine

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
RUN mkdir -p /data /bot-data && chown node:node /data /bot-data
COPY --chown=node:node VERSION README.md ./
COPY --chown=node:node config ./config
COPY --chown=node:node public ./public
COPY --chown=node:node schemas ./schemas
COPY --chown=node:node examples ./examples
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src

ENV HOST=0.0.0.0 \
    PORT=8787 \
    RESET_DATA_DIR=/data \
    RESET_SCHEDULER_ENABLED=true

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/live').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"

USER node

CMD ["node", "src/server.mjs"]
