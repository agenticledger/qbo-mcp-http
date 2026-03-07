#!/usr/bin/env node
/**
 * QuickBooks Online MCP Server — Exposed via Streamable HTTP
 *
 * Two auth modes:
 *
 * 1. OAuth flow (recommended for end users):
 *    - User visits /auth/connect → redirected to Intuit login
 *    - After authorization, callback returns an API key
 *    - User sets  Authorization: Bearer qbo_xxx  in their MCP config
 *    - Server auto-refreshes tokens transparently
 *
 * 2. Raw passthrough (legacy):
 *    - Authorization: Bearer <raw-qbo-access-token>
 *    - X-Realm-Id: <company-realm-id>
 *    - X-Qbo-Environment: sandbox | production
 */

import { randomUUID } from 'node:crypto';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema as _zodToJsonSchema } from 'zod-to-json-schema';
import { QBOClient } from './api-client.js';
import { tools } from './tools.js';
import {
  generateApiKey,
  storeToken,
  getToken,
  updateToken,
  deleteToken,
  listTokens,
  isExpired,
  isRefreshExpired,
  type StoredToken,
} from './token-store.js';

function zodToJsonSchema(schema: any): any {
  return _zodToJsonSchema(schema);
}

// --- Config ---
const PORT = parseInt(process.env.PORT || '3100', 10);
const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID || '';
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || '';
const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI || '';
const QBO_ENVIRONMENT = (process.env.QBO_ENVIRONMENT as 'sandbox' | 'production') || 'sandbox';
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || `http://localhost:${PORT}`;

const oauthEnabled = !!(QBO_CLIENT_ID && QBO_CLIENT_SECRET && QBO_REDIRECT_URI);

// --- Intuit OAuth helpers (no SDK dependency — just fetch) ---
const INTUIT_AUTH_BASE =
  QBO_ENVIRONMENT === 'sandbox'
    ? 'https://appcenter.intuit.com/connect/oauth2'
    : 'https://appcenter.intuit.com/connect/oauth2';

const INTUIT_TOKEN_URL =
  QBO_ENVIRONMENT === 'sandbox'
    ? 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
    : 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function getAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: QBO_CLIENT_ID,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: QBO_REDIRECT_URI,
    state,
  });
  return `${INTUIT_AUTH_BASE}?${params.toString()}`;
}

async function exchangeCode(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}> {
  const basicAuth = Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(INTUIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: QBO_REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}> {
  const basicAuth = Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(INTUIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Resolve credentials from the Authorization header.
 * Supports both API key (qbo_xxx) and raw passthrough.
 */
async function resolveCredentials(
  req: express.Request
): Promise<{ accessToken: string; realmId: string; environment: 'sandbox' | 'production' } | null> {
  const auth = req.headers.authorization;
  if (!auth) return null;

  const bearer = auth.replace(/^Bearer\s+/i, '');
  if (!bearer) return null;

  // --- API key mode (starts with qbo_) ---
  if (bearer.startsWith('qbo_')) {
    const stored = getToken(bearer);
    if (!stored) return null;

    // Auto-refresh if expired
    if (isExpired(stored)) {
      if (isRefreshExpired(stored)) {
        console.log(`[auth] Refresh token expired for realm ${stored.realmId} — user must re-authorize`);
        return null;
      }
      try {
        console.log(`[auth] Auto-refreshing token for realm ${stored.realmId}...`);
        const refreshed = await refreshAccessToken(stored.refreshToken);
        updateToken(bearer, {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          expiresAt: Date.now() + refreshed.expires_in * 1000,
          refreshExpiresAt: Date.now() + refreshed.x_refresh_token_expires_in * 1000,
          lastUsedAt: Date.now(),
        });
        return {
          accessToken: refreshed.access_token,
          realmId: stored.realmId,
          environment: stored.environment,
        };
      } catch (err) {
        console.error(`[auth] Auto-refresh failed:`, err);
        return null;
      }
    }

    // Token still valid
    updateToken(bearer, { lastUsedAt: Date.now() });
    return {
      accessToken: stored.accessToken,
      realmId: stored.realmId,
      environment: stored.environment,
    };
  }

  // --- Raw passthrough mode (legacy) ---
  const realmId = req.headers['x-realm-id'] as string | undefined;
  if (!realmId) return null;
  const envHeader = req.headers['x-qbo-environment'] as string | undefined;
  const environment: 'sandbox' | 'production' =
    envHeader === 'sandbox' ? 'sandbox' : 'production';
  return { accessToken: bearer, realmId, environment };
}

// --- Express app ---
const app = express();
app.use(express.json());

// ==================== HEALTH CHECK ====================
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'qbo-mcp-http',
    version: '2.0.0',
    tools: tools.length,
    transport: 'streamable-http',
    oauthEnabled,
    authModes: [
      ...(oauthEnabled ? ['oauth (recommended): visit /auth/connect'] : []),
      'bearer-passthrough: Authorization + X-Realm-Id headers',
    ],
  });
});

// ==================== OAUTH ROUTES ====================
// Pending OAuth states (short-lived, in-memory)
const pendingStates = new Map<string, { createdAt: number }>();

// GET /auth/connect — start OAuth flow
app.get('/auth/connect', (_req, res) => {
  if (!oauthEnabled) {
    res.status(503).json({
      error: 'OAuth not configured.',
      hint: 'Set QBO_CLIENT_ID, QBO_CLIENT_SECRET, and QBO_REDIRECT_URI env vars.',
    });
    return;
  }
  const state = randomUUID();
  pendingStates.set(state, { createdAt: Date.now() });
  // Clean up old states (>10 min)
  for (const [k, v] of pendingStates) {
    if (Date.now() - v.createdAt > 600_000) pendingStates.delete(k);
  }
  const url = getAuthUrl(state);
  res.redirect(url);
});

// GET /auth/callback — Intuit redirects here after user authorizes
app.get('/auth/callback', async (req, res) => {
  const { code, state, realmId, error } = req.query as Record<string, string>;

  if (error) {
    res.status(400).json({ error: `Intuit OAuth error: ${error}` });
    return;
  }

  if (!state || !pendingStates.has(state)) {
    res.status(400).json({ error: 'Invalid or expired OAuth state. Please start again at /auth/connect' });
    return;
  }
  pendingStates.delete(state);

  if (!code || !realmId) {
    res.status(400).json({ error: 'Missing authorization code or realmId from Intuit' });
    return;
  }

  try {
    const tokenResp = await exchangeCode(code);
    const apiKey = generateApiKey();

    // Try to fetch company name for display
    let companyName: string | undefined;
    try {
      const client = new QBOClient(tokenResp.access_token, realmId, QBO_ENVIRONMENT);
      const info = await client.getCompanyInfo();
      companyName = info?.CompanyInfo?.CompanyName || info?.QueryResponse?.CompanyInfo?.[0]?.CompanyName;
    } catch {
      // Not critical
    }

    storeToken({
      apiKey,
      realmId,
      accessToken: tokenResp.access_token,
      refreshToken: tokenResp.refresh_token,
      environment: QBO_ENVIRONMENT,
      expiresAt: Date.now() + tokenResp.expires_in * 1000,
      refreshExpiresAt: Date.now() + tokenResp.x_refresh_token_expires_in * 1000,
      companyName,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });

    console.log(`[auth] New connection: realm=${realmId} company=${companyName || 'unknown'}`);

    // Return a nice HTML page with the API key
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>QBO MCP - Connected</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; color: #333; }
    .success { background: #d4edda; border: 1px solid #c3e6cb; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
    .key-box { background: #f8f9fa; border: 2px solid #dee2e6; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 14px; word-break: break-all; cursor: pointer; }
    .key-box:hover { border-color: #007bff; }
    code { background: #e9ecef; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    pre { background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
    h1 { color: #28a745; }
    .warning { background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px; padding: 16px; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="success">
    <h1>Connected!</h1>
    <p>QuickBooks company <strong>${companyName || realmId}</strong> is now linked.</p>
  </div>

  <h3>Your API Key</h3>
  <div class="key-box" onclick="navigator.clipboard.writeText('${apiKey}').then(() => this.style.borderColor='#28a745')" title="Click to copy">
    ${apiKey}
  </div>
  <p style="font-size: 13px; color: #666;">Click to copy. Keep this safe — it's your authentication credential.</p>

  <h3>MCP Configuration</h3>
  <p>Add this to your Claude Desktop <code>claude_desktop_config.json</code>:</p>
  <pre>{
  "mcpServers": {
    "quickbooks": {
      "url": "${SERVER_BASE_URL}/mcp",
      "headers": {
        "Authorization": "Bearer ${apiKey}"
      }
    }
  }
}</pre>

  <div class="warning">
    <strong>Token auto-refresh:</strong> Your access token will be refreshed automatically.
    The refresh token lasts ~100 days. After that, visit <a href="/auth/connect">/auth/connect</a> to re-authorize.
  </div>
</body>
</html>`);
  } catch (err: any) {
    console.error('[auth] Token exchange failed:', err);
    res.status(500).json({
      error: 'Failed to exchange authorization code',
      detail: err.message,
    });
  }
});

// GET /auth/status/:apiKey — check token status
app.get('/auth/status/:apiKey', (req, res) => {
  const stored = getToken(req.params.apiKey);
  if (!stored) {
    res.status(404).json({ error: 'API key not found' });
    return;
  }
  res.json({
    realmId: stored.realmId,
    companyName: stored.companyName,
    environment: stored.environment,
    tokenExpired: Date.now() >= stored.expiresAt,
    tokenExpiresAt: new Date(stored.expiresAt).toISOString(),
    refreshExpired: Date.now() >= stored.refreshExpiresAt,
    refreshExpiresAt: new Date(stored.refreshExpiresAt).toISOString(),
    createdAt: new Date(stored.createdAt).toISOString(),
    lastUsedAt: new Date(stored.lastUsedAt).toISOString(),
  });
});

// DELETE /auth/revoke/:apiKey — revoke a connection
app.delete('/auth/revoke/:apiKey', (req, res) => {
  const deleted = deleteToken(req.params.apiKey);
  if (!deleted) {
    res.status(404).json({ error: 'API key not found' });
    return;
  }
  res.json({ status: 'revoked' });
});

// GET /auth/connections — list all connections (admin, no secrets exposed)
app.get('/auth/connections', (_req, res) => {
  const all = listTokens().map((t) => ({
    apiKeyPrefix: t.apiKey.substring(0, 12) + '...',
    realmId: t.realmId,
    companyName: t.companyName,
    environment: t.environment,
    tokenExpired: Date.now() >= t.expiresAt,
    refreshExpired: Date.now() >= t.refreshExpiresAt,
    createdAt: new Date(t.createdAt).toISOString(),
    lastUsedAt: new Date(t.lastUsedAt).toISOString(),
  }));
  res.json({ connections: all, count: all.length });
});

// ==================== MCP SERVER ====================

interface SessionState {
  server: Server;
  transport: StreamableHTTPServerTransport;
  client: QBOClient;
}

const sessions = new Map<string, SessionState>();

function createMCPServer(client: QBOClient): Server {
  const server = new Server(
    { name: 'qbo-mcp-server', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    try {
      const result = await tool.handler(client, args as any);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// POST /mcp — MCP session entry point
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  // Existing session
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session — resolve credentials (API key or raw passthrough)
  const creds = await resolveCredentials(req);
  if (!creds) {
    res.status(401).json({
      error: 'Authentication required.',
      options: {
        oauth: oauthEnabled
          ? `Visit ${SERVER_BASE_URL}/auth/connect to get an API key`
          : 'OAuth not configured on this server',
        passthrough: {
          'Authorization': 'Bearer <your-qbo-access-token>',
          'X-Realm-Id': '<your-company-realm-id>',
          'X-Qbo-Environment': 'sandbox | production (default: production)',
        },
        apiKey: 'Authorization: Bearer qbo_xxx (after completing OAuth flow)',
      },
    });
    return;
  }

  const client = new QBOClient(creds.accessToken, creds.realmId, creds.environment);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const server = createMCPServer(client);

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) {
      sessions.delete(sid);
      console.log(`[mcp] Session closed: ${sid}`);
    }
  };

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  const newSessionId = transport.sessionId;
  if (newSessionId) {
    sessions.set(newSessionId, { server, transport, client });
    console.log(`[mcp] New session: ${newSessionId} (realm: ${creds.realmId}, env: ${creds.environment})`);
  }
});

// GET /mcp — SSE stream for server notifications
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session. Send initialization POST first.' });
    return;
  }
  const { transport } = sessions.get(sessionId)!;
  await transport.handleRequest(req, res);
});

// DELETE /mcp — close session
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const { transport, server } = sessions.get(sessionId)!;
  await transport.close();
  await server.close();
  sessions.delete(sessionId);
  res.status(200).json({ status: 'session closed' });
});

// ==================== START ====================
app.listen(PORT, () => {
  console.log(`QuickBooks Online MCP HTTP Server v2.0.0`);
  console.log(`  MCP endpoint:   ${SERVER_BASE_URL}/mcp`);
  console.log(`  Health check:   ${SERVER_BASE_URL}/health`);
  console.log(`  Tools:          ${tools.length}`);
  console.log(`  Transport:      Streamable HTTP`);
  console.log(`  OAuth:          ${oauthEnabled ? 'ENABLED — /auth/connect' : 'DISABLED (set QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI)'}`);
  console.log(`  Auth modes:     ${oauthEnabled ? 'API key (OAuth) + ' : ''}Bearer passthrough`);
});
