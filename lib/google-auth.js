// "Sign in with Google" — OAuth 2.0 Authorization Code flow, no extra dependency
// (Node 20+ has global fetch). Falls back to disabled (routes return a clear error)
// if GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET aren't set, same pattern as lib/razorpay.js.
const crypto = require('crypto');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const isConfigured = () => !!(CLIENT_ID && CLIENT_SECRET);

// The redirect URI must exactly match one of the "Authorized redirect URIs" set on
// the Google Cloud OAuth client. We compute it from the incoming request (protocol +
// host) rather than hardcoding one domain, so this works on itcresume.in,
// www.itcresume.in and the .vercel.app address alike — all three were registered.
function redirectUri(req) {
  return `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
}

function authUrl(req, state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

// Exchanges the one-time `code` Google sent back for the signed-in person's email,
// name and whether Google itself has verified that email address.
async function exchangeCode(req, code) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri(req), grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw new Error('google_token_exchange_failed');
  const tokens = await tokenRes.json();
  if (!tokens.access_token) throw new Error('google_token_exchange_failed');

  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: 'Bearer ' + tokens.access_token },
  });
  if (!infoRes.ok) throw new Error('google_userinfo_failed');
  const info = await infoRes.json();
  if (!info.email) throw new Error('google_userinfo_failed');
  return { email: String(info.email).toLowerCase(), name: info.name || info.given_name || '', emailVerified: !!info.email_verified };
}

const randomState = () => crypto.randomBytes(24).toString('base64url');

module.exports = { isConfigured, authUrl, exchangeCode, randomState };
