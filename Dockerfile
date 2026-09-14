# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY providers/executor/package.json providers/executor/package-lock.json ./providers/executor/
RUN --mount=type=cache,target=/root/.npm npm ci --prefix providers/executor --ignore-scripts --no-audit --no-fund
COPY providers/executor/runner.js providers/executor/runtime.js providers/executor/LICENSE ./providers/executor/
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY examples ./examples
COPY scripts ./scripts
COPY providers/cloudflare/worker.js ./providers/cloudflare/worker.js
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24.21.0-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /data /fixture /run/action-space-secrets
WORKDIR /app
ENV NODE_ENV=production ACTION_SPACE_DATA=/data PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/providers/executor ./providers/executor
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/dist/scripts ./dist/scripts
COPY --from=build /app/dist/examples ./dist/examples
COPY package.json ./
COPY migrations ./migrations
COPY config/local.json ./config/local.json
USER node
EXPOSE 3000
ENTRYPOINT ["node", "dist/scripts/container.js"]
CMD ["serve"]
