# Riverdesk public website (apps/website): static pages served by next start.
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /repo
COPY . .
# Only this app and the workspace packages it uses.
RUN pnpm install --frozen-lockfile --filter @vs/website...
# NEXT_PUBLIC_* values are baked into the pages at build time; Railway passes service
# variables of the same name as build arguments.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_API_DOCS_URL
ARG NEXT_PUBLIC_CONTACT_EMAIL
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
RUN pnpm --filter @vs/website build
WORKDIR /repo/apps/website
EXPOSE 3000
CMD ["sh", "-c", "exec node_modules/.bin/next start -H 0.0.0.0 -p ${PORT:-3000}"]
