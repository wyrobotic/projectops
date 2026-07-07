// api/config.js — public runtime config consumed by the frontend on load.
// Returns ONLY non-secret, client-safe values. The Clerk publishable key is
// designed to live in client code, so exposing it here is safe; this lets each
// deployment be driven entirely by env vars with no hardcoded key in the HTML.
// No auth guard — this must load before sign-in to bootstrap Clerk.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || '',
  });
}
