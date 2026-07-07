/**
 * Connections-Broker client (auth model "B" — broker-first).
 *
 * This MCP holds ZERO provider secrets. The only secret it carries is a broker
 * *install identity* (installBearer + JWT signing key from the broker's /register),
 * which merely grants "ask MY broker for a token scoped to this caller". It cannot
 * touch any provider OAuth app or any other account's vault.
 *
 * Per request the MCP:
 *   1. derives a `principal` (see index.ts — gateway header or install fallback),
 *   2. signs a short-lived HS256 JWT { clientNamespace, principal },
 *   3. calls the broker (POST /token) to resolve a ready-to-use QuickBooks token
 *      (+ realmId), refreshing transparently in the broker,
 *   4. calls the QuickBooks API directly with it.
 *
 * When the caller hasn't connected QuickBooks yet, the broker returns 404 and this
 * module surfaces a connect link (POST /connect -> authorizeUrl) for the one-time
 * consent — the tool never hard-errors (connect-on-first-call).
 *
 * Contract: ~/Desktop/APPs/connections-broker/INTEGRATION.md
 */

import jwt from 'jsonwebtoken';

const BROKER_BASE_URL = (process.env.BROKER_BASE_URL || 'https://connectionsbroker.agenticledger.ai').replace(/\/$/, '');
const INSTALL_BEARER = process.env.BROKER_INSTALL_BEARER || '';
const JWT_KEY = process.env.BROKER_JWT_KEY || '';
const CLIENT_NAMESPACE = process.env.BROKER_CLIENT_NAMESPACE || '';

/** True only when all three install-identity secrets are present. */
export const brokerConfigured = Boolean(INSTALL_BEARER && JWT_KEY && CLIENT_NAMESPACE);

export const brokerBaseUrl = BROKER_BASE_URL;
export const brokerClientNamespace = CLIENT_NAMESPACE;

/** The QuickBooks provider name as seeded in the broker (PROVIDER_SEED). */
const QBO_PROVIDER = 'quickbooks';

function signBrokerToken(principal: string): string {
  return jwt.sign(
    { clientNamespace: CLIENT_NAMESPACE, principal },
    JWT_KEY,
    { algorithm: 'HS256', expiresIn: '60s' }
  );
}

async function brokerFetch(path: string, principal: string, body: unknown): Promise<Response> {
  return fetch(`${BROKER_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${INSTALL_BEARER}`,
      'X-Broker-Token': signBrokerToken(principal),
    },
    body: JSON.stringify(body),
  });
}

export type QboTokenResult =
  | { status: 'connected'; accessToken: string; realmId: string; expiresAt: string | null }
  | { status: 'not_connected' }
  | { status: 'error'; message: string };

/**
 * Resolve the caller's QuickBooks access token + realmId from the broker.
 * 404 -> the caller hasn't connected yet (connect-on-first-call).
 */
export async function resolveQuickbooksToken(principal: string, account = ''): Promise<QboTokenResult> {
  try {
    const res = await brokerFetch('/token', principal, { provider: QBO_PROVIDER, ...(account ? { account } : {}) });
    if (res.status === 404) return { status: 'not_connected' };
    if (!res.ok) return { status: 'error', message: `broker /token -> ${res.status} ${await res.text()}` };
    const data = (await res.json()) as { accessToken?: string; realmId?: string; expiresAt?: string | null };
    if (!data.accessToken || !data.realmId) {
      return { status: 'error', message: 'broker /token returned no accessToken/realmId (is this a QuickBooks connection?)' };
    }
    return { status: 'connected', accessToken: data.accessToken, realmId: data.realmId, expiresAt: data.expiresAt ?? null };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Start a QuickBooks connection for the caller and return the one-time consent URL.
 * The user opens it once (Intuit login -> pick company); the token lands in the broker
 * vault; the next tool call resolves it. State is single-use, expires in ~10 min.
 */
export async function startQuickbooksConnect(principal: string, account = ''): Promise<{ authorizeUrl: string } | { error: string }> {
  try {
    const res = await brokerFetch('/connect', principal, { provider: QBO_PROVIDER, ...(account ? { account } : {}) });
    if (!res.ok) return { error: `broker /connect -> ${res.status} ${await res.text()}` };
    const data = (await res.json()) as { authorizeUrl?: string };
    if (!data.authorizeUrl) return { error: 'broker /connect returned no authorizeUrl' };
    return { authorizeUrl: data.authorizeUrl };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
