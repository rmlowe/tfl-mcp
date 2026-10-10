import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const keySets = new Map();

// Configuration is trusted deployment input, never inferred from request headers or JWT claims.
export function mcpAuthConfig(env) {
  const mode = env.MCP_AUTH_MODE ?? 'bearer';
  if (mode === 'bearer') {
    return typeof env.MCP_AUTH_TOKEN === 'string' && env.MCP_AUTH_TOKEN.length >= 32
      ? { mode, token: env.MCP_AUTH_TOKEN } : null;
  }
  if (mode !== 'access') return null;
  const issuer = env.MCP_ACCESS_TEAM_DOMAIN;
  const audience = env.MCP_ACCESS_AUD;
  if (typeof issuer !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer)
      || typeof audience !== 'string' || !audience.trim() || audience !== audience.trim()) return null;
  return { mode, issuer, audience };
}

export async function authenticateMcp(request, config) {
  if (config.mode === 'bearer') {
    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) return false;
    const encode = new TextEncoder();
    const hashes = await Promise.all([authorization.slice(7), config.token].map(
      token => crypto.subtle.digest('SHA-256', encode.encode(token))));
    return timingSafeEqual(new Uint8Array(hashes[0]), new Uint8Array(hashes[1]));
  }
  // Managed OAuth's opaque bearer token is resolved by Access at the edge.
  // Only the signed assertion is usable here; no shared-token fallback in Access mode.
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion || assertion.length > 16384) return false;
  try {
    let keys = keySets.get(config.issuer);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), {
        timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 300000,
      });
      if (keySets.size >= 8) keySets.delete(keySets.keys().next().value);
      keySets.set(config.issuer, keys);
    }
    const { payload } = await jwtVerify(assertion, keys, {
      issuer: config.issuer, audience: config.audience, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub'], clockTolerance: 0,
    });
    return typeof payload.sub === 'string' && payload.sub.length > 0
      && payload.iat <= Math.floor(Date.now() / 1000);
  } catch {
    // Includes missing keys, network failures, invalid signatures and claims. Never log tokens.
    return false;
  }
}
