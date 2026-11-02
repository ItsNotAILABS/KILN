/**
 * OAuth 2.0 provider layer — Google + X.
 *
 * This module knows ONLY the providers: their endpoints, the daemon's
 * configuration (env), PKCE, the authorization URL, and the
 * server-side code exchange + identity fetch. It holds NO account
 * state — identity resolution into the one account model lives in
 * lib/accounts.mjs (the OAuth section there), which calls in here.
 *
 * Configuration (daemon env):
 *   KILN_OAUTH_GOOGLE_CLIENT_ID / KILN_OAUTH_GOOGLE_CLIENT_SECRET
 *   KILN_OAUTH_X_CLIENT_ID      / KILN_OAUTH_X_CLIENT_SECRET
 *   KILN_OAUTH_REDIRECT_BASE    (optional; default
 *                                https://kiln.pocketnova.app)
 *
 * The public callback URI for a provider is byte-for-byte
 *   <redirectBase>/api/forge/v1/accounts/oauth/<provider>/callback
 * — the app origin proxies /api/forge/* to the daemon's /v1/* (the
 * proxy strips the "/api/forge" prefix: kiln-workspace
 * scripts/serve-original.mjs, "Forge API proxy: /api/forge/X ->
 * daemon /X"), so the daemon route itself is
 * /v1/accounts/oauth/<provider>/callback. These exact public URIs
 * are what the operator registers in the provider consoles.
 *
 * Test/config seam: every function accepts an `overrides` object
 * ({ clientId, clientSecret, redirectBase, authUrl, tokenUrl,
 * userinfoUrl }) and a `fetchImpl`; the endpoint overrides may also
 * come from env (KILN_OAUTH_<PROVIDER>_AUTH_URL / _TOKEN_URL /
 * _USERINFO_URL) so a test can point the token/userinfo endpoints at
 * a local stub server without touching provider code. Client
 * secrets are never logged and never placed in a URL.
 */
import { createHash, randomBytes } from "node:crypto";

export const OAUTH_PROVIDERS = {
  google: {
    id: "google",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
  },
  x: {
    id: "x",
    authUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    userinfoUrl: "https://api.twitter.com/2/users/me",
    scope: "tweet.read users.read",
  },
};

export const OAUTH_DEFAULT_REDIRECT_BASE = "https://kiln.pocketnova.app";

function envPrefix(provider) {
  return provider === "google" ? "GOOGLE" : "X";
}

/**
 * Resolve one provider's config. Returns
 * { provider, clientId, clientSecret, redirectBase, redirectUri,
 *   authUrl, tokenUrl, userinfoUrl, scope, configured }.
 * `configured` is true only when BOTH the client id and secret are
 * present — anything else is the honest not-configured state.
 */
export function oauthProviderConfig(provider, env = process.env, overrides = {}) {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) return null;
  const p = envPrefix(provider);
  const redirectBase = String(
    overrides.redirectBase || env.KILN_OAUTH_REDIRECT_BASE || OAUTH_DEFAULT_REDIRECT_BASE
  ).replace(/\/+$/, "");
  const clientId = overrides.clientId ?? env[`KILN_OAUTH_${p}_CLIENT_ID`] ?? "";
  const clientSecret = overrides.clientSecret ?? env[`KILN_OAUTH_${p}_CLIENT_SECRET`] ?? "";
  return {
    provider,
    clientId: String(clientId || ""),
    clientSecret: String(clientSecret || ""),
    redirectBase,
    redirectUri: `${redirectBase}/api/forge/v1/accounts/oauth/${provider}/callback`,
    authUrl: overrides.authUrl || env[`KILN_OAUTH_${p}_AUTH_URL`] || def.authUrl,
    tokenUrl: overrides.tokenUrl || env[`KILN_OAUTH_${p}_TOKEN_URL`] || def.tokenUrl,
    userinfoUrl: overrides.userinfoUrl || env[`KILN_OAUTH_${p}_USERINFO_URL`] || def.userinfoUrl,
    scope: overrides.scope || def.scope,
    configured: !!(clientId && clientSecret),
  };
}

/** A PKCE pair: verifier (kept server-side, in the state record) + S256 challenge. */
export function makePkce() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  return { verifier, challenge, method: "S256" };
}

/** The provider authorization URL the start route 302s to. */
export function buildAuthorizationUrl(config, { state, codeChallenge }) {
  const u = new URL(config.authUrl);
  u.searchParams.set("client_id", config.clientId);
  u.searchParams.set("redirect_uri", config.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", config.scope);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

/**
 * Exchange an authorization code at the provider's token endpoint
 * (server-side, PKCE verifier included) and fetch the identity.
 * Returns a normalized identity:
 *   google: { provider, subject, email, emailVerified, name }
 *   x:      { provider, subject, username, name, email: null,
 *             emailVerified: false }
 * X does not reliably return an email — callers must not depend on
 * one. Throws a plain Error with a provider-stage message on any
 * provider failure; the message never carries provider response
 * bodies (they can echo request data) or any secret.
 */
export async function exchangeCodeForIdentity(config, { code, codeVerifier }, fetchImpl = fetch) {
  const form = new URLSearchParams({
    code,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (config.provider === "x") {
    // X requires HTTP Basic client authentication for confidential
    // clients at the token endpoint.
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
    form.set("client_id", config.clientId);
  } else {
    form.set("client_id", config.clientId);
    form.set("client_secret", config.clientSecret);
  }
  const tokenRes = await fetchImpl(config.tokenUrl, { method: "POST", headers, body: form.toString() });
  if (!tokenRes.ok) throw new Error(`provider token exchange failed (HTTP ${tokenRes.status})`);
  const token = await readJson(tokenRes);
  if (!token.access_token) throw new Error("provider token exchange returned no access token");

  const idRes = await fetchImpl(config.userinfoUrl, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!idRes.ok) throw new Error(`provider identity fetch failed (HTTP ${idRes.status})`);
  const raw = await readJson(idRes);

  if (config.provider === "google") {
    if (!raw.sub) throw new Error("provider identity response carried no subject");
    return {
      provider: "google",
      subject: String(raw.sub),
      email: typeof raw.email === "string" && raw.email ? raw.email : null,
      emailVerified: raw.email_verified === true,
      name: typeof raw.name === "string" ? raw.name : null,
      username: null,
    };
  }
  const d = raw.data || raw;
  if (!d.id) throw new Error("provider identity response carried no subject");
  return {
    provider: "x",
    subject: String(d.id),
    email: null,
    emailVerified: false,
    name: typeof d.name === "string" ? d.name : null,
    username: typeof d.username === "string" ? d.username : null,
  };
}
