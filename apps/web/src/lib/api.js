// API client. In dev, Vite proxies /api to the Express backend (same origin, so
// the HttpOnly session cookie is sent automatically).
// When the backend is unreachable, pages fall back to bundled fixtures
// (fixtures/fictional.js) and say so explicitly.

export async function apiGet(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' }, credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status}).`);
  }
  return res.json();
}

export async function apiPost(path, payload, { csrfToken } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    credentials: 'include',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error ?? `Request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Anonymous variants: cookies are DELIBERATELY omitted so the server cannot
// link group fetches or ballot submissions to a login session.
export async function apiGetAnon(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status}).`);
  }
  return res.json();
}

export async function apiPostAnon(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error ?? `Request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** SHA-256 hex using the Web Crypto API (established primitive, no custom crypto). */
export async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
