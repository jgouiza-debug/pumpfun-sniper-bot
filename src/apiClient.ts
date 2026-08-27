/**
 * Authenticated fetch for the local bot API.
 *
 * The server refuses mutating calls without a bearer token (services/apiAuth.ts).
 * Two ways the UI gets one:
 *
 *  - Served build: the token is injected into index.html, so it is present
 *    before the first render and no round trip is needed.
 *  - vite dev server, or a call aimed at a DIFFERENT instance's port: fetch it
 *    from that origin's /api/session-token, which is loopback-gated.
 *
 * Tokens are cached per origin because the instance switcher points one UI at
 * several ports, and instances installed in different directories do not share
 * a token file.
 */

const injectedToken: string | null =
  typeof window !== 'undefined' ? ((window as any).__SNIPER_API_TOKEN__ ?? null) : null;

const tokenByOrigin = new Map<string, Promise<string | null>>();

function originOf(url: string): string {
  try {
    return new URL(url, typeof window !== 'undefined' ? window.location.href : undefined).origin;
  } catch {
    return typeof window !== 'undefined' ? window.location.origin : '';
  }
}

function tokenFor(origin: string): Promise<string | null> {
  // Our own origin served us the page, so the injected token is already correct.
  if (injectedToken && typeof window !== 'undefined' && origin === window.location.origin) {
    return Promise.resolve(injectedToken);
  }

  const cached = tokenByOrigin.get(origin);
  if (cached) return cached;

  const pending = fetch(`${origin}/api/session-token`)
    .then(res => (res.ok ? res.json() : null))
    .then(body => (typeof body?.token === 'string' ? body.token : null))
    .catch(() => null)
    .then(token => {
      // A failed lookup must not be cached forever — that instance may simply
      // not be up yet, and the switcher retries.
      if (token === null) tokenByOrigin.delete(origin);
      return token;
    });

  tokenByOrigin.set(origin, pending);
  return pending;
}

/** Drop-in `fetch` that attaches the API token for the target origin. */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await tokenFor(originOf(url));
  const headers = new Headers(init.headers);
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}
