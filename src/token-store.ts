/**
 * Multi-user token store for QBO OAuth credentials.
 *
 * Each user who completes the OAuth flow gets a generated API key.
 * Tokens are stored in a JSON file so they survive server restarts.
 * Auto-refresh is handled transparently when tokens expire.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

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

const STORE_PATH = path.resolve(process.env.TOKEN_STORE_PATH || './data/tokens.json');

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
  const parsed = JSON.parse(ciphertext);
  if (!parsed.encrypted) return ciphertext; // plaintext fallback
  if (!ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY required to decrypt stored tokens');
  const decipher = createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(parsed.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'));
  let decrypted = decipher.update(parsed.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// In-memory cache backed by file
let tokens: Map<string, StoredToken> = new Map();

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadFromDisk() {
  try {
    if (existsSync(STORE_PATH)) {
      const raw = readFileSync(STORE_PATH, 'utf-8');
      let json: string;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.encrypted) {
          json = decrypt(raw);
        } else if (Array.isArray(parsed)) {
          json = raw; // already plaintext array
        } else {
          json = decrypt(raw);
        }
      } catch {
        json = raw; // assume plaintext
      }
      const arr: StoredToken[] = JSON.parse(json);
      tokens = new Map(arr.map((t) => [t.apiKey, t]));
    }
  } catch {
    tokens = new Map();
  }
}

function saveToDisk() {
  ensureDir(STORE_PATH);
  const json = JSON.stringify(Array.from(tokens.values()), null, 2);
  writeFileSync(STORE_PATH, encrypt(json), 'utf-8');
}

// Load on import
loadFromDisk();

export function generateApiKey(): string {
  return `qbo_${randomBytes(24).toString('hex')}`;
}

export function storeToken(token: StoredToken): void {
  tokens.set(token.apiKey, token);
  saveToDisk();
}

export function getToken(apiKey: string): StoredToken | undefined {
  return tokens.get(apiKey);
}

export function updateToken(apiKey: string, updates: Partial<StoredToken>): StoredToken | undefined {
  const existing = tokens.get(apiKey);
  if (!existing) return undefined;
  const updated = { ...existing, ...updates };
  tokens.set(apiKey, updated);
  saveToDisk();
  return updated;
}

export function deleteToken(apiKey: string): boolean {
  const deleted = tokens.delete(apiKey);
  if (deleted) saveToDisk();
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
  // Consider expired 60s before actual expiry to avoid race conditions
  return Date.now() >= token.expiresAt - 60_000;
}

export function isRefreshExpired(token: StoredToken): boolean {
  return Date.now() >= token.refreshExpiresAt;
}
