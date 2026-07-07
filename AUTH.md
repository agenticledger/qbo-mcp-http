# QBO MCP — Auth model (BROKER-FIRST, model "B")

This MCP holds **zero QuickBooks/Intuit secrets**. It is a *client* of the
**Connections Broker** (`https://connectionsbroker.agenticledger.ai`), which is the
registered Intuit OAuth app, owns the `client_id`/`client_secret`, runs the consent
flow, and stores + auto-refreshes each user's token encrypted at rest.

The only secret this MCP carries is a **broker install identity** (`installBearer`
+ `jwtSigningKey` from the broker's `POST /register`). That is not a provider secret:
it only grants "ask *my* broker for a token scoped to this caller." It cannot touch
the Intuit OAuth app or any other account's vault.

This is the **reference migration** for the whole HTTP-MCP fleet.

---

## Request flow

```
Claude / agent ──POST /mcp──► QBO MCP ──POST /token {provider:quickbooks}──► Broker ──► (vault)
                                  │  (Authorization: install Bearer                     │
                                  │   X-Broker-Token: HS256 JWT{clientNamespace,principal})
                                  │◄──────── { accessToken, realmId } ──────────────────┘
                                  └──GET /v3/company/{realmId}/... (Bearer accessToken)──► Intuit QBO API
```

Per request the MCP:
1. derives a `principal` from the request (see below),
2. signs a short-lived (60s) HS256 JWT `{ clientNamespace, principal }` with `BROKER_JWT_KEY`,
3. `POST /token` (with `Authorization: Bearer <installBearer>` + `X-Broker-Token: <jwt>`)
   for `provider: "quickbooks"`,
4. on **200** → builds a `QBOClient(accessToken, realmId)` and calls Intuit directly;
   the broker auto-refreshed in the background if needed,
5. on **404 (not connected)** → **connect-on-first-call**: `POST /connect` → returns the
   Intuit `authorizeUrl`, surfaced to the caller as a structured tool message (never an
   error). The user opens it once, connects, retries — it works.

Resolution happens **per tool call** (lazily), which is what lets a not-connected caller
receive the connect link instead of a hard failure at session start.

---

## THE OPEN DECISION — how the MCP learns `principal` (settled)

**Decision: the platform gateway sets a request header `X-Broker-Principal` on the
`/mcp` request; its value is the broker `principal`. Per-agent isolation, with an
optional HMAC signature for unforgeability and a per-install fallback for standalone
callers.**

Rationale and the exact contract:

### 1. Primary — `X-Broker-Principal` header (per AGENT)
- The gateway already derives a per-agent context server-side (the same plumbing that
  produces `MYAIFORONE_SENDER`). It sets:
  ```
  X-Broker-Principal: <instanceId>:<agentId>
  ```
- The MCP uses that value **verbatim** as the broker `principal`. The broker derives
  `subject = sha256("<clientNamespace>:<principal>")` server-side, so the subject is
  never sent and one agent can never address another's vault. **Per-agent** means one
  install running 20 agents gets 20 isolated QuickBooks connections — they never collide.
- Header name is configurable via `BROKER_PRINCIPAL_HEADER` (default `x-broker-principal`)
  so we can instead reuse whatever agent-context header the gateway already emits.

### 2. Integrity — `X-Broker-Principal-Sig` (recommended in production)
- Because this MCP is **publicly reachable on Railway**, a plain header is forgeable by
  anyone hitting the URL directly (they could impersonate another agent's principal and
  read a vault that agent connected). To close that hole **without** reverting to model
  "A" (gateway-injects-the-token), the gateway also sends:
  ```
  X-Broker-Principal-Sig: base64url( HMAC-SHA256(principal, SHARED_KEY) )
  ```
  and the MCP verifies it when `BROKER_PRINCIPAL_HMAC_KEY` is set. `SHARED_KEY` is a
  secret known only to the gateway and this MCP (set on both). With it set, the principal
  header is unforgeable even on a public host.
- **Pilot posture:** `BROKER_PRINCIPAL_HMAC_KEY` is left **unset** — the header is trusted
  on the network hop. Flip it on (set the same key on the gateway and the MCP) before
  relying on public multi-tenant isolation.

### 3. Fallback — standalone external Claude (no agent framework)
- If **no** principal header is present, the MCP uses `BROKER_FALLBACK_PRINCIPAL`
  (default `default`). The whole install is then a single principal / single agent —
  exactly the "point your own Claude at the hosted URL and it just works" case. That
  caller connects once (connect-on-first-call) and thereafter resolves its own token.

### 4. Escape hatch — raw passthrough (holds no secret)
- A caller may bypass the broker entirely by sending its own token:
  `Authorization: Bearer <raw-qbo-access-token>` + `X-Realm-Id: <realmId>`
  (+ optional `X-Qbo-Environment: sandbox|production`). Useful for testing and for
  callers who already hold a QBO token. No secret is stored by the MCP.

### What the platform gateway must do (wiring that depends on this decision)
1. On each proxied `/mcp` request to this MCP, set `X-Broker-Principal: <instanceId>:<agentId>`
   (or point `BROKER_PRINCIPAL_HEADER` at the existing agent-context header).
2. For public multi-tenant safety, also set `X-Broker-Principal-Sig` (HMAC of the principal
   with the shared key) and set that same key as `BROKER_PRINCIPAL_HMAC_KEY` on this MCP.
3. Nothing else — the gateway does **not** call `/token`, does **not** hold any provider or
   broker secret, and does **not** inject a Bearer. That is the whole point of model B:
   the MCP + broker work even with no gateway in the path.

---

## Railway environment variables (set these on the qbo-mcp-http service)

| Var | Value | Notes |
|---|---|---|
| `BROKER_BASE_URL` | `https://connectionsbroker.agenticledger.ai` | default; omit to use default |
| `BROKER_CLIENT_NAMESPACE` | *(install identity)* | from `POST /register` |
| `BROKER_INSTALL_BEARER` | *(install identity — secret)* | from `POST /register` |
| `BROKER_JWT_KEY` | *(install identity — secret)* | from `POST /register` |
| `BROKER_PRINCIPAL_HEADER` | `x-broker-principal` | or the gateway's existing agent header |
| `BROKER_PRINCIPAL_HMAC_KEY` | *(shared with gateway)* | OPTIONAL; set to enforce unforgeable principals |
| `BROKER_FALLBACK_PRINCIPAL` | `default` | standalone single-principal mode |
| `QBO_ENVIRONMENT` | `production` | broker's QuickBooks app is production |

**Remove** the deprecated vars (no longer read): `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
`QBO_REDIRECT_URI`, `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`.

---

## What was removed in the migration (phase-2 vault rip)

- `src/token-store.ts` — the `qbo_xxx` API-key minting + Postgres token store + AES vault.
- Routes: `/authorize`, `/oauth/register`, `/oauth/token`, `/auth/connect`, `/auth/callback`,
  `/auth/status/:apiKey`, `/auth/revoke/:apiKey`, `/auth/connections`.
- The Intuit OAuth app plumbing: `QBO_CLIENT_ID/SECRET/REDIRECT_URI`, `getAuthUrl`,
  `exchangeCode`, `refreshAccessToken`, and the in-memory Claude-PKCE flow maps.
- `pg` dependency. Added `jsonwebtoken` for signing the broker JWT.

Unchanged: the QuickBooks API client (`src/api-client.ts`), the tools
(`src/tools.ts`), and the phase-1 OAuth-trap fix (well-known stays de-advertised).
