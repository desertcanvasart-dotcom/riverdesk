# Riverdesk Channel API (apps/api): Fastify, run from TypeScript with tsx. Listens on $PORT.
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /repo
COPY . .
# Only this app and the workspace packages it uses.
RUN pnpm install --frozen-lockfile --filter @vs/api...
ENV NODE_ENV=production
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["sh", "-c", "exec node_modules/.bin/tsx src/main.ts"]
