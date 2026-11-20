# Node services (api, web, pipeline worker) from the pnpm monorepo.
# The pipeline worker uses the Playwright image (Chromium + deps preinstalled) via NODE_IMAGE.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
# optional: corporate/proxy CA certificates (put *.crt files in docker/certs/)
COPY docker/certs/ /usr/local/share/ca-certificates/extra/
RUN (command -v update-ca-certificates >/dev/null && update-ca-certificates >/dev/null 2>&1) || true
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY workers/node/package.json workers/node/
COPY packages/shared/package.json packages/shared/
COPY packages/vision/package.json packages/vision/
COPY packages/server/package.json packages/server/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .

FROM deps AS api
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["pnpm", "start"]

FROM deps AS worker
# PLAYWRIGHT_BROWSERS_PATH is set by the Playwright base image (/ms-playwright)
WORKDIR /app/workers/node
CMD ["pnpm", "start"]

FROM deps AS web
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
ARG NEXT_PUBLIC_MAPBOX_TOKEN=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY NEXT_PUBLIC_MAPBOX_TOKEN=$NEXT_PUBLIC_MAPBOX_TOKEN
WORKDIR /app/apps/web
RUN pnpm build
EXPOSE 3000
CMD ["pnpm", "start"]
