# Riverdesk public website (apps/website): static pages served by next start, plus the
# /pilot form, which stores requests through the vs_website database role.
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
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_WHATSAPP_NUMBER
ARG NEXT_PUBLIC_FOUNDING_SEATS
ARG NEXT_PUBLIC_DEMO_VIDEO_URL_AR
ARG NEXT_PUBLIC_DEMO_VIDEO_URL_EN
ARG NEXT_PUBLIC_DEMO_VIDEO_CAPTIONS_AR
ARG NEXT_PUBLIC_DEMO_VIDEO_CAPTIONS_EN
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
RUN pnpm --filter @vs/website build
WORKDIR /repo/apps/website
EXPOSE 3000
CMD ["sh", "-c", "exec node_modules/.bin/next start -H 0.0.0.0 -p ${PORT:-3000}"]
