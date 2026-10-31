// Server-side sessions: random 256-bit ids in an HttpOnly, SameSite=Lax cookie
// (Secure in production), plus a per-session CSRF token that mutations must
// return in the X-CSRF-Token header. No session data is stored client-side.

export const SESSION_COOKIE = 'cp_session';
export const CSRF_HEADER = 'x-csrf-token';

export function sessionCookieOptions(config) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionTtlMs,
  };
}

export function clearSessionCookie(res, config) {
  res.clearCookie(SESSION_COOKIE, { path: '/', secure: config.cookieSecure, sameSite: 'lax' });
}

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

/** Resolve the request's session or throw 401. */
export async function requireSession(store, req) {
  const id = req.cookies?.[SESSION_COOKIE];
  if (!id || typeof id !== 'string') fail('Not authenticated: no session.', 401);
  const session = await store.getSession(id);
  if (!session) fail('Not authenticated: session expired or unknown.', 401);
  return session;
}

/** Double-check the CSRF token for cookie-authenticated mutations. */
export function requireCsrf(session, req) {
  const presented = req.headers?.[CSRF_HEADER];
  if (!presented || presented !== session.csrfToken) {
    fail('CSRF token missing or invalid.', 403);
  }
}
