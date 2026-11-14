# Riverdesk Channel API (apps/api): Fastify, run from TypeScript with tsx. Listens on $PORT.
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /repo
# Dependencies first, from the lockfile alone: this layer is reused until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY . .
# Only this app and the workspace packages it uses.
RUN pnpm install --offline --frozen-lockfile --filter @vs/api...
ENV NODE_ENV=production
WORKDIR /repo/apps/api
# Not root: nothing it does needs it.
USER node
EXPOSE 4000
CMD ["sh", "-c", "exec node_modules/.bin/tsx src/main.ts"]
