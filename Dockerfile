FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/
COPY packages/bundler/package.json packages/bundler/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY packages/api packages/api
COPY packages/bundler packages/bundler
COPY packages/shared packages/shared
RUN pnpm build

FROM base AS runtime
COPY --from=deps /app ./
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/bundler/dist ./packages/bundler/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000 3001
ENV HEALTHCHECK_URL=http://localhost:3000/health
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch(process.env.HEALTHCHECK_URL).then((r) => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
CMD ["node", "packages/api/dist/server.js"]
