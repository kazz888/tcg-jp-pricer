// The only server code in this app: one backup slot for your bookmarks and
// collection, so they survive a phone clearing website data. Everything else
// is still the static build in dist/, served without running this file.
//
// Setup once:  npx wrangler secret put SYNC_KEY    (a long passphrase)
// The KV namespace behind the STATE binding is created by the first deploy.

// KV values cap at 25 MiB; photo-heavy collections are the only way near it.
const MAX_BYTES = 20 * 1024 * 1024

function keyOk(request, env) {
  if (!env.SYNC_KEY) return false
  const enc = new TextEncoder()
  const given = enc.encode(request.headers.get('x-sync-key') ?? '')
  const want = enc.encode(env.SYNC_KEY)
  return given.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(given, want)
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/api/state') return new Response('Not found', { status: 404 })
    if (!keyOk(request, env)) return new Response('Wrong sync key', { status: 401 })

    if (request.method === 'GET') {
      return new Response((await env.STATE.get('state')) ?? 'null', {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    }
    if (request.method === 'PUT') {
      const body = await request.text()
      if (body.length > MAX_BYTES) return new Response('Too large', { status: 413 })
      let state = null
      try {
        state = JSON.parse(body)
      } catch {}
      if (!state || !Array.isArray(state.bookmarks) || !Array.isArray(state.collection)) {
        return new Response('Expected { bookmarks: [], collection: [] }', { status: 400 })
      }
      await env.STATE.put('state', body)
      return new Response(null, { status: 204 })
    }
    return new Response('Method not allowed', { status: 405 })
  },
}
