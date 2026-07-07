// api/_auth.js — Clerk token verification for ProjectOPS serverless functions
// Prefixed with _ so Vercel does not expose this as a function endpoint.

import { verifyToken } from '@clerk/backend';

/**
 * Verifies the Bearer token in the Authorization header using Clerk.
 * Returns the payload (truthy) on success, null on failure.
 *
 * Uses the standalone verifyToken() export — compatible with Node.js
 * http.IncomingMessage (Vercel serverless functions).
 *
 * Since all data is shared (no user_id), we only need to confirm the
 * request is authenticated — not which user made it.
 */
export async function requireAuth(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    return payload || null;
  } catch (e) {
    // TEMP DIAGNOSTIC — remove once the new-instance 401s are resolved.
    // Logs NO secret material: only the error, the token's issuer, and the
    // secret key's prefix + length so we can spot an app/instance mismatch.
    let iss = 'unknown';
    try { iss = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64').toString('utf8')).iss; } catch {}
    const sk = process.env.CLERK_SECRET_KEY || '';
    console.error('[auth] verifyToken failed:', e && e.message,
      '| token.iss:', iss,
      '| CLERK_SECRET_KEY:', sk ? `${sk.slice(0, 8)}…(len ${sk.length})` : 'MISSING');
    return null;
  }
}
