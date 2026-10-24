# Riverdesk back office (apps/backoffice): the staff app. Runtime settings come from Railway
# variables (database, Supabase Auth, passport key); nothing secret is needed to build it.
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /repo
COPY . .
# Only this app and the workspace packages it uses.
RUN pnpm install --frozen-lockfile --filter @vs/backoffice...
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
RUN pnpm --filter @vs/backoffice build
WORKDIR /repo/apps/backoffice
EXPOSE 3000
CMD ["sh", "-c", "exec node_modules/.bin/next start -H 0.0.0.0 -p ${PORT:-3000}"]
