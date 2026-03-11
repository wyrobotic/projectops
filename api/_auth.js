// api/_auth.js — Clerk token verification for ProjectOPS serverless functions
// Prefixed with _ so Vercel does not expose this as a function endpoint.

import { createClerkClient } from '@clerk/backend';

const clerk = createClerkClient({
  secretKey:      process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});

/**
 * Verifies the Bearer token in the Authorization header using Clerk.
 * Returns the auth object (truthy) on success, null on failure.
 *
 * Since all data is shared (no user_id), we only need to confirm the
 * request is authenticated — not which user made it.
 *
 * Usage in every data endpoint:
 *   const auth = await requireAuth(req);
 *   if (!auth) return res.status(401).json({ error: 'Unauthorized' });
 */
export async function requireAuth(req) {
  try {
    const requestState = await clerk.authenticateRequest(req, {
      authorizedParties: [process.env.APP_URL],
    });
    if (!requestState.isAuthenticated) return null;
    return requestState.toAuth();
  } catch {
    return null;
  }
}
