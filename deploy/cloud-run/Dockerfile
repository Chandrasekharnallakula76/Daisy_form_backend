# syntax=docker/dockerfile:1
# Build from the parent directory containing Daisy_form/ and Daisy_form_backend/.
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /build/frontend
RUN corepack enable && corepack prepare yarn@1.22.22 --activate
COPY Daisy_form/package.json Daisy_form/yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive
COPY Daisy_form/index.html Daisy_form/vite.config.ts Daisy_form/tsconfig*.json ./
COPY Daisy_form/src/ ./src/
COPY Daisy_form/public/ ./public/
# This script explicitly clears VITE_API_URL to keep requests on the same origin.
RUN yarn build:production

FROM node:22-bookworm-slim AS backend-dependencies
WORKDIR /build/backend
# better-sqlite3 remains available for local/legacy maintenance. These tools are
# needed only if npm cannot obtain a matching native prebuild.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY Daisy_form_backend/package.json Daisy_form_backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STORAGE_BACKEND=postgres \
    DB_SSL_MODE=verify-full \
    DB_SSL_SERVERNAME=0ede6ea68d67.1rm5nct1ov6wn.northamerica-northeast1.sql-psa.goog \
    STATIC_DIR=/app/frontend/dist \
    APP_BASE_PATH=/ \
    TRUST_PROXY_HOPS=1
WORKDIR /app/backend
COPY --chown=node:node --from=backend-dependencies /build/backend/node_modules ./node_modules
COPY --chown=node:node Daisy_form_backend/package.json Daisy_form_backend/package-lock.json ./
COPY --chown=node:node Daisy_form_backend/src/ ./src/
COPY --chown=node:node Daisy_form_backend/scripts/ ./scripts/
COPY --chown=node:node --from=frontend-build /build/frontend/dist/ /app/frontend/dist/
USER node
EXPOSE 8080
# Exec form delivers Cloud Run's SIGTERM directly to the Node server.
CMD ["node", "src/server.js"]
