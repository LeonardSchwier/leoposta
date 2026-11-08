# Leoposta container image: Express API + pre-built PWA on one port.
# Builds with `docker build` and `podman build` alike. Base pinned by tag and digest
# (multi-arch index: linux/amd64 and linux/arm64).
ARG NODE_IMAGE=docker.io/library/node:22.23.4-alpine3.24@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202

# ---- build: install all deps, build the frontend -----------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
# The frontend needs the API token at build time. A fixed placeholder is baked in
# and replaced at container start (container/entrypoint.sh), so no secret is in the image.
RUN VITE_LEOPOSTA_TOKEN=__LEOPOSTA_TOKEN__ npm run build

# ---- deps: production dependencies only --------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Leoposta" \
      org.opencontainers.image.description="Web-based IMAP/SMTP mail client" \
      org.opencontainers.image.source="https://github.com/LeonardSchwier/leoposta" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    LEOPOSTA_DATA_DIR=/data
WORKDIR /app
COPY --from=deps  --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY container/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh && mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/index.js"]
