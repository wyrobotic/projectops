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
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    return payload || null;
  } catch {
    return null;
  }
}
