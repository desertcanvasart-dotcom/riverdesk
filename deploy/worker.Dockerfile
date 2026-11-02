# Riverdesk worker (apps/worker): background jobs and document rendering. It needs headless
# Chromium (Playwright) and its system libraries, installed here. No port: it serves nothing.
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /repo
COPY . .
# Only this app and the workspace packages it uses.
RUN pnpm install --frozen-lockfile --filter @vs/worker...
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm --filter @vs/worker exec playwright install --with-deps chromium
ENV NODE_ENV=production
WORKDIR /repo/apps/worker
# Not root: the image's own unprivileged user, so Chromium can run with its sandbox and a
# Chromium bug in a rendered document does not give root in the container.
USER node
CMD ["sh", "-c", "exec node_modules/.bin/tsx src/main.ts"]
