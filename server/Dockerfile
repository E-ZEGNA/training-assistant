FROM node:24.14.0-alpine AS dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY student/package.json ./student/package.json
RUN npm ci --omit=dev --workspace server --include-workspace-root=false

FROM node:24.14.0-alpine AS runtime
WORKDIR /app/server

RUN addgroup -S -g 1001 appgroup \
    && adduser -S -u 1001 -G appgroup appuser \
    && mkdir -p /app/server/data \
    && chown -R appuser:appgroup /app/server

COPY --from=dependencies /app/node_modules /app/node_modules
COPY --chown=appuser:appgroup server/package.json ./package.json
COPY --chown=appuser:appgroup server/src ./src
COPY --chown=appuser:appgroup server/scripts ./scripts

USER appuser
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/server/data
EXPOSE 8787
VOLUME ["/app/server/data"]

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
