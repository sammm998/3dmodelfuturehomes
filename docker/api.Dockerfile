# API (Fastify). Also used for migrations/seed (pre-deploy).
FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
# optional: corporate/proxy CA certificates (put *.crt files in docker/certs/)
COPY docker/certs/ /usr/local/share/ca-certificates/extra/
RUN (command -v update-ca-certificates >/dev/null && update-ca-certificates >/dev/null 2>&1) || true
# behind a TLS-intercepting proxy also set NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
# fonts for server-side SVG rendering (seed floor plan labels)
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
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

WORKDIR /app/apps/api
EXPOSE 4000
CMD ["pnpm", "start"]
