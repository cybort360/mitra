# The engine for Fly (fly.toml): Core API, MCP gateway, webhook worker and keeper in one
# machine, run by scripts/serve-all.mjs. Testnets only; secrets come from Fly, never the image.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Full install: tsx, viem and @solana/web3.js are devDependencies but the daemons and the
# settlement rails load them at runtime.
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3005 \
    MCP_GATEWAY_PORT=3006 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app /app
EXPOSE 3005 3006
CMD ["node", "scripts/serve-all.mjs"]
