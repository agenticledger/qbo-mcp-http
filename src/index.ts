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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/static', express.static(path.join(__dirname, 'public')));

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
    res.status(503).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QBO MCP - Configuration Required</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root{--primary:#2563EB;--primary-dark:#1D4ED8;--primary-light:#DBEAFE;--primary-50:#EFF6FF;--fg:#0F172A;--muted:#64748B;--surface:#F8FAFC;--border:#E2E8F0;--danger:#EF4444;--danger-light:#FEE2E2;}
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'DM Sans',sans-serif;color:var(--fg);min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--surface);background-image:linear-gradient(135deg,var(--primary-50) 0%,var(--surface) 50%,#F0F9FF 100%);background-size:400% 400%;animation:gradientShift 15s ease infinite;}
    @keyframes gradientShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
    .card{background:#fff;border:1px solid var(--border);border-radius:16px;padding:40px;max-width:520px;width:100%;margin:20px;box-shadow:0 1px 3px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06);animation:slideUp .5s ease-out;}
    @keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
    .header{display:flex;align-items:center;gap:14px;margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid var(--border);}
    .header img{height:36px;}
    .header span{font-size:18px;font-weight:700;color:var(--fg);}
    .error-banner{background:var(--danger-light);border:1px solid #FECACA;border-radius:12px;padding:16px 20px;margin-bottom:24px;display:flex;align-items:flex-start;gap:12px;}
    .error-banner svg{flex-shrink:0;margin-top:2px;}
    .error-banner .text{font-size:14px;color:#991B1B;line-height:1.5;}
    .error-banner .text strong{display:block;margin-bottom:4px;font-size:15px;}
    .hint{font-size:13px;color:var(--muted);line-height:1.6;}
    .hint code{font-family:'JetBrains Mono',monospace;background:var(--primary-50);padding:2px 6px;border-radius:4px;font-size:12px;color:var(--primary-dark);}
    .footer{margin-top:24px;padding-top:16px;border-top:1px solid var(--border);text-align:center;font-size:12px;color:var(--muted);}
  </style>
</head>
<body>
  <div class="card">
    <div class="header"><img src="/static/logo.png" alt="AgenticLedger"><span>QuickBooks Online MCP</span></div>
    <div class="error-banner">
      <svg width="20" height="20" fill="none" viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#EF4444"/><path d="M10 6v5M10 13.5v.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>
      <div class="text"><strong>OAuth Not Configured</strong>The server requires OAuth credentials to connect to QuickBooks.</div>
    </div>
    <div class="hint">
      <p>Set the following environment variables and restart:</p>
      <ul style="margin-top:8px;padding-left:20px;">
        <li><code>QBO_CLIENT_ID</code></li>
        <li><code>QBO_CLIENT_SECRET</code></li>
        <li><code>QBO_REDIRECT_URI</code></li>
      </ul>
    </div>
    <div class="footer">Secured by Intuit &middot; AgenticLedger</div>
  </div>
</body>
</html>`);
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

    // Return a branded HTML page with the API key
    const mcpConfig = JSON.stringify({
      mcpServers: {
        quickbooks: {
          url: `${SERVER_BASE_URL}/mcp`,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    }, null, 2);

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QBO MCP - Connected</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root{--primary:#2563EB;--primary-dark:#1D4ED8;--primary-light:#DBEAFE;--primary-50:#EFF6FF;--fg:#0F172A;--muted:#64748B;--surface:#F8FAFC;--border:#E2E8F0;--success:#10B981;--success-light:#D1FAE5;}
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'DM Sans',sans-serif;color:var(--fg);min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--surface);background-image:linear-gradient(135deg,var(--primary-50) 0%,var(--surface) 50%,#F0F9FF 100%);background-size:400% 400%;animation:gradientShift 15s ease infinite;}
    @keyframes gradientShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
    .card{background:#fff;border:1px solid var(--border);border-radius:16px;padding:40px;max-width:600px;width:100%;margin:20px;box-shadow:0 1px 3px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06);animation:slideUp .5s ease-out;}
    @keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
    .header{display:flex;align-items:center;gap:14px;margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid var(--border);}
    .header img{height:36px;}
    .header span{font-size:18px;font-weight:700;color:var(--fg);}
    .success-banner{background:var(--success-light);border:1px solid #A7F3D0;border-radius:12px;padding:16px 20px;margin-bottom:28px;display:flex;align-items:center;gap:12px;}
    .success-banner svg{flex-shrink:0;}
    .success-banner .text{font-size:15px;font-weight:600;color:#065F46;}
    .success-banner .text span{font-weight:400;display:block;font-size:13px;color:#047857;margin-top:2px;}
    .section-title{font-size:14px;font-weight:600;color:var(--fg);margin-bottom:10px;display:flex;align-items:center;gap:8px;}
    .section-title svg{color:var(--muted);}
    .key-box{background:var(--primary-50);border:2px solid var(--primary-light);border-radius:12px;padding:14px 16px;font-family:'JetBrains Mono',monospace;font-size:13px;word-break:break-all;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;transition:border-color .2s;}
    .key-box:hover{border-color:var(--primary);}
    .key-box .key-text{flex:1;color:var(--primary-dark);user-select:all;}
    .copy-btn{background:var(--primary);color:#fff;border:none;border-radius:10px;padding:8px 16px;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;transition:background .15s;white-space:nowrap;}
    .copy-btn:hover{background:var(--primary-dark);}
    .copy-btn.copied{background:var(--success);}
    .hint{font-size:12px;color:var(--muted);margin-bottom:24px;}
    .config-block{position:relative;margin-bottom:24px;}
    .config-pre{background:#1E293B;border-radius:12px;padding:20px;overflow-x:auto;font-family:'JetBrains Mono',monospace;font-size:12.5px;line-height:1.7;margin:0;color:#E2E8F0;}
    .config-pre .json-key{color:#7DD3FC;}
    .config-pre .json-str{color:#86EFAC;}
    .config-pre .json-brace{color:#94A3B8;}
    .config-copy{position:absolute;top:12px;right:12px;background:rgba(255,255,255,.1);color:#CBD5E1;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:6px 12px;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:500;cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:4px;}
    .config-copy:hover{background:rgba(255,255,255,.2);color:#fff;}
    .config-copy.copied{background:rgba(16,185,129,.3);color:#86EFAC;border-color:rgba(16,185,129,.4);}
    .info-box{background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px;padding:16px 20px;margin-bottom:24px;display:flex;align-items:flex-start;gap:12px;}
    .info-box svg{flex-shrink:0;margin-top:1px;}
    .info-box .text{font-size:13px;color:#92400E;line-height:1.5;}
    .info-box .text strong{font-weight:600;}
    .info-box .text a{color:#D97706;font-weight:500;}
    .footer{padding-top:20px;border-top:1px solid var(--border);text-align:center;font-size:12px;color:var(--muted);}
  </style>
</head>
<body>
  <div class="card">
    <div class="header"><img src="/static/logo.png" alt="AgenticLedger"><span>QuickBooks Online MCP</span></div>

    <div class="success-banner">
      <svg width="24" height="24" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#10B981"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div class="text">Connected to QuickBooks<span>${companyName || realmId}</span></div>
    </div>

    <div class="section-title">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
      Your API Key
    </div>
    <div class="key-box">
      <span class="key-text" id="apiKeyText">${apiKey}</span>
      <button class="copy-btn" onclick="copyText('${apiKey}',this)">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        Copy
      </button>
    </div>
    <div class="hint">This key authenticates all MCP requests. Store it securely.</div>

    <div class="section-title">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/></svg>
      MCP Configuration
    </div>
    <p style="font-size:13px;color:var(--muted);margin-bottom:12px;">Add this to your <code style="font-family:'JetBrains Mono',monospace;background:var(--primary-50);padding:2px 6px;border-radius:4px;font-size:12px;color:var(--primary-dark);">claude_desktop_config.json</code>:</p>
    <div class="config-block">
      <pre class="config-pre"><span class="json-brace">{</span>
  <span class="json-key">"mcpServers"</span>: <span class="json-brace">{</span>
    <span class="json-key">"quickbooks"</span>: <span class="json-brace">{</span>
      <span class="json-key">"url"</span>: <span class="json-str">"${SERVER_BASE_URL}/mcp"</span>,
      <span class="json-key">"headers"</span>: <span class="json-brace">{</span>
        <span class="json-key">"Authorization"</span>: <span class="json-str">"Bearer ${apiKey}"</span>
      <span class="json-brace">}</span>
    <span class="json-brace">}</span>
  <span class="json-brace">}</span>
<span class="json-brace">}</span></pre>
      <button class="config-copy" onclick="copyConfig(this)">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        Copy
      </button>
    </div>

    <div class="info-box">
      <svg width="20" height="20" fill="none" viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="#FBBF24"/><path d="M10 6v5M10 13.5v.5" stroke="#92400E" stroke-width="1.5" stroke-linecap="round"/></svg>
      <div class="text"><strong>Token auto-refresh:</strong> Access tokens are refreshed automatically. The refresh token lasts ~100 days. After expiry, visit <a href="/auth/connect">/auth/connect</a> to re-authorize.</div>
    </div>

    <div class="footer">Secured by Intuit &middot; AgenticLedger</div>
  </div>

  <script>
    function copyText(text,btn){
      navigator.clipboard.writeText(text).then(()=>{
        btn.classList.add('copied');btn.innerHTML='<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> Copied!';
        setTimeout(()=>{btn.classList.remove('copied');btn.innerHTML='<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy';},2000);
      });
    }
    function copyConfig(btn){
      const config = JSON.stringify(${JSON.stringify(JSON.parse(mcpConfig))},null,2);
      navigator.clipboard.writeText(config).then(()=>{
        btn.classList.add('copied');btn.textContent='Copied!';
        setTimeout(()=>{btn.classList.remove('copied');btn.innerHTML='<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy';},2000);
      });
    }
  </script>
</body>
</html>`);
  } catch (err: any) {
    console.error('[auth] Token exchange failed:', err);
    res.status(500).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QBO MCP - Error</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root{--primary:#2563EB;--primary-50:#EFF6FF;--fg:#0F172A;--muted:#64748B;--surface:#F8FAFC;--border:#E2E8F0;--danger:#EF4444;--danger-light:#FEE2E2;}
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'DM Sans',sans-serif;color:var(--fg);min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--surface);background-image:linear-gradient(135deg,var(--primary-50) 0%,var(--surface) 50%,#F0F9FF 100%);background-size:400% 400%;animation:gradientShift 15s ease infinite;}
    @keyframes gradientShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
    .card{background:#fff;border:1px solid var(--border);border-radius:16px;padding:40px;max-width:520px;width:100%;margin:20px;box-shadow:0 1px 3px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06);animation:slideUp .5s ease-out;}
    @keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
    .header{display:flex;align-items:center;gap:14px;margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid var(--border);}
    .header img{height:36px;}
    .header span{font-size:18px;font-weight:700;color:var(--fg);}
    .error-banner{background:var(--danger-light);border:1px solid #FECACA;border-radius:12px;padding:16px 20px;margin-bottom:24px;}
    .error-banner strong{display:block;color:#991B1B;margin-bottom:4px;}
    .error-banner p{font-size:13px;color:#991B1B;font-family:'JetBrains Mono',monospace;word-break:break-all;}
    .retry{display:inline-block;margin-top:16px;padding:10px 24px;background:var(--primary);color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;}
    .retry:hover{background:#1D4ED8;}
    .footer{margin-top:24px;padding-top:16px;border-top:1px solid var(--border);text-align:center;font-size:12px;color:var(--muted);}
  </style>
</head>
<body>
  <div class="card">
    <div class="header"><img src="/static/logo.png" alt="AgenticLedger"><span>QuickBooks Online MCP</span></div>
    <div class="error-banner">
      <strong>Connection Failed</strong>
      <p>${err.message?.replace(/</g, '&lt;').replace(/>/g, '&gt;') || 'Failed to exchange authorization code'}</p>
    </div>
    <a class="retry" href="/auth/connect">Try Again</a>
    <div class="footer">Secured by Intuit &middot; AgenticLedger</div>
  </div>
</body>
</html>`);
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
