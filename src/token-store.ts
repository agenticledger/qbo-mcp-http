/**
 * Multi-user token store for QBO OAuth credentials.
 *
 * Each user who completes the OAuth flow gets a generated API key.
 * Tokens are stored in PostgreSQL so they survive redeploys.
 * Sensitive fields encrypted with AES-256-GCM before storage.
 * Auto-refresh is handled transparently when tokens expire.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import pg from 'pg';

export interface StoredToken {
  apiKey: string;
  realmId: string;
  accessToken: string;
  refreshToken: string;
  environment: 'sandbox' | 'production';
  expiresAt: number; // epoch ms
  refreshExpiresAt: number; // epoch ms — refresh tokens last ~100 days
  companyName?: string;
  createdAt: number;
  lastUsedAt: number;
}

// --- Encryption ---

const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY
  ? Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex')
  : null;

if (!ENCRYPTION_KEY) {
  console.warn('[token-store] WARNING: TOKEN_ENCRYPTION_KEY not set — storing tokens in plaintext. Set a 64-char hex key for encryption.');
}

function encrypt(plaintext: string): string {
  if (!ENCRYPTION_KEY) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return JSON.stringify({ encrypted: true, iv: iv.toString('hex'), tag, data: encrypted });
}

function decrypt(ciphertext: string): string {
  try {
    const parsed = JSON.parse(ciphertext);
    if (!parsed.encrypted) return ciphertext;
    if (!ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY required to decrypt stored tokens');
    const decipher = createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(parsed.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'));
    let decrypted = decipher.update(parsed.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return ciphertext; // plaintext fallback
  }
}

// --- PostgreSQL ---

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[token-store] Unexpected pool error:', err.message);
});

// In-memory cache for fast reads
let tokens: Map<string, StoredToken> = new Map();

async function loadFromDb() {
  try {
    const { rows } = await pool.query('SELECT * FROM qbo_tokens');
    tokens = new Map();
    for (const row of rows) {
      tokens.set(row.api_key, {
        apiKey: row.api_key,
        realmId: row.realm_id,
        accessToken: decrypt(row.access_token),
        refreshToken: decrypt(row.refresh_token),
        environment: row.environment as 'sandbox' | 'production',
        expiresAt: Number(row.expires_at),
        refreshExpiresAt: Number(row.refresh_expires_at),
        companyName: row.company_name || undefined,
        createdAt: Number(row.created_at),
        lastUsedAt: Number(row.last_used_at),
      });
    }
    console.log(`[token-store] Loaded ${tokens.size} tokens from database`);
  } catch (err: any) {
    console.error('[token-store] Failed to load from database:', err.message);
    tokens = new Map();
  }
}

async function upsertToDb(token: StoredToken) {
  await pool.query(
    `INSERT INTO qbo_tokens (api_key, realm_id, access_token, refresh_token, environment, expires_at, refresh_expires_at, company_name, created_at, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (api_key) DO UPDATE SET
       realm_id = EXCLUDED.realm_id,
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       environment = EXCLUDED.environment,
       expires_at = EXCLUDED.expires_at,
       refresh_expires_at = EXCLUDED.refresh_expires_at,
       company_name = EXCLUDED.company_name,
       last_used_at = EXCLUDED.last_used_at`,
    [
      token.apiKey,
      token.realmId,
      encrypt(token.accessToken),
      encrypt(token.refreshToken),
      token.environment,
      token.expiresAt,
      token.refreshExpiresAt,
      token.companyName || null,
      token.createdAt,
      token.lastUsedAt,
    ]
  );
}

async function deleteFromDb(apiKey: string) {
  await pool.query('DELETE FROM qbo_tokens WHERE api_key = $1', [apiKey]);
}

// Load on startup
loadFromDb();

export function generateApiKey(): string {
  return `qbo_${randomBytes(24).toString('hex')}`;
}

export function storeToken(token: StoredToken): void {
  tokens.set(token.apiKey, token);
  upsertToDb(token).catch((err) => console.error('[token-store] DB write error:', err.message));
}

export function getToken(apiKey: string): StoredToken | undefined {
  return tokens.get(apiKey);
}

export function updateToken(apiKey: string, updates: Partial<StoredToken>): StoredToken | undefined {
  const existing = tokens.get(apiKey);
  if (!existing) return undefined;
  const updated = { ...existing, ...updates };
  tokens.set(apiKey, updated);
  upsertToDb(updated).catch((err) => console.error('[token-store] DB write error:', err.message));
  return updated;
}

export function deleteToken(apiKey: string): boolean {
  const deleted = tokens.delete(apiKey);
  if (deleted) deleteFromDb(apiKey).catch((err) => console.error('[token-store] DB delete error:', err.message));
  return deleted;
}

export function listTokens(): StoredToken[] {
  return Array.from(tokens.values());
}

export function getTokenByRealm(realmId: string): StoredToken | undefined {
  for (const token of tokens.values()) {
    if (token.realmId === realmId) return token;
  }
  return undefined;
}

export function isExpired(token: StoredToken): boolean {
  return Date.now() >= token.expiresAt - 60_000;
}

export function isRefreshExpired(token: StoredToken): boolean {
  return Date.now() >= token.refreshExpiresAt;
}
