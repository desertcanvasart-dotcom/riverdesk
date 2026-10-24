---
title: Authentication
summary: Client credentials, tokens, and rotating secrets without downtime.
---

# Authentication

The cruise company creates an **API client** for you in Riverdesk and sends you:

- a **client ID** (`vsc_…`), which is not secret;
- a **client secret** (`vss_…`), shown to them once. Keep it on your server only.

## Getting a token

```bash
curl -s -X POST "$API/oauth/token" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials
```

```json
{ "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 900 }
```

Send it on every call as `Authorization: Bearer <token>`. Tokens last 15 minutes. When a call returns `401 UNAUTHENTICATED`, get a new token and retry.

The client ID and secret may also be sent as form fields (`client_id`, `client_secret`) instead of Basic auth.

## Rotating the secret

A client can have two active secrets at once, so you can change secrets without downtime:

1. Ask the company for a **second secret**.
2. Deploy it and check that tokens work.
3. Ask them to **revoke** the old one.

## Rate limit

Each client may make 600 requests per minute, unless the company sets another limit. Above it you get `429 RATE_LIMITED` with a `Retry-After` header in seconds.
