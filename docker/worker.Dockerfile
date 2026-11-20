# Pipeline worker (BullMQ orchestrator + Playwright scraper). Base image ships Chromium.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
# optional: corporate/proxy CA certificates (put *.crt files in docker/certs/)
COPY docker/certs/ /usr/local/share/ca-certificates/extra/
RUN (command -v update-ca-certificates >/dev/null && update-ca-certificates >/dev/null 2>&1) || true
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
RUN npm install -g pnpm@10.28.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY workers/node/package.json workers/node/
COPY packages/shared/package.json packages/shared/
COPY packages/vision/package.json packages/vision/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile
COPY . .

WORKDIR /app/workers/node
CMD ["pnpm", "start"]
