/**
 * Shared Zoho OAuth token cache.
 * Caches the access token to disk so multiple script runs within the
 * token's lifetime (~55 min) skip re-authentication.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, '..', '.token-cache.json');

// Zoho access tokens last 60 min; we treat them as valid for 55 min
const TOKEN_TTL_MS = 55 * 60 * 1000;

async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(data) {
  await fs.writeFile(CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Returns a valid access token, using the disk cache when possible.
 * Falls back to a fresh token via the Zoho refresh-token grant.
 */
export async function getCachedToken(cfg) {
  const cached = await readCache();
  if (cached && cached.accessToken && cached.expiresAt && Date.now() < cached.expiresAt) {
    return cached.accessToken;
  }

  // Cache miss or expired → refresh
  const body = new URLSearchParams({
    refresh_token: cfg.zoho.refreshToken,
    client_id: cfg.zoho.clientId,
    client_secret: cfg.zoho.clientSecret,
    grant_type: 'refresh_token'
  });

  const res = await fetch(`https://accounts.zoho.${cfg.zoho.region}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(json)}`);
  }

  await writeCache({
    accessToken: json.access_token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
    refreshedAt: new Date().toISOString()
  });

  return json.access_token;
}
