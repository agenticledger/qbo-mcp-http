/**
 * Multi-user token store for QBO OAuth credentials.
 *
 * Each user who completes the OAuth flow gets a generated API key.
 * Tokens are stored in a JSON file so they survive server restarts.
 * Auto-refresh is handled transparently when tokens expire.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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

// In-memory cache backed by file
let tokens: Map<string, StoredToken> = new Map();

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    const { mkdirSync } = require('node:fs');
    mkdirSync(dir, { recursive: true });
  }
}

function loadFromDisk() {
  try {
    if (existsSync(STORE_PATH)) {
      const raw = readFileSync(STORE_PATH, 'utf-8');
      const arr: StoredToken[] = JSON.parse(raw);
      tokens = new Map(arr.map((t) => [t.apiKey, t]));
    }
  } catch {
    tokens = new Map();
  }
}

function saveToDisk() {
  ensureDir(STORE_PATH);
  const arr = Array.from(tokens.values());
  writeFileSync(STORE_PATH, JSON.stringify(arr, null, 2), 'utf-8');
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
