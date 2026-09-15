/* Offline support for the shop app.
 *
 * Design constraint: a broken service worker is worse than no service worker,
 * so this one is deliberately small and does exactly two things.
 *
 *   1. Navigations are served from the cache first, always. The app shell
 *      carries every price inside it, so a cached shell IS a working app.
 *      A background refresh updates the copy for next time; it is allowed to
 *      fail silently, which is what happens in a basement with no signal.
 *   2. Same-origin assets (the hashed JS Astro emits) are cache-first and
 *      filled in on first use. That is why the SECOND visit works fully
 *      offline without the worker needing to know the hashed filenames.
 *
 * Bump VERSION to evict everything after a deploy.
 */

var VERSION = 'v1'
var CACHE = 'tcg-jp-pricer-' + VERSION
// Card art lives on Yuyu-tei's CDN, so it is cross-origin and opaque. It gets
// its own cache, filled in as you look at cards: the ones you checked with
// signal are still there in a basement. Never pre-fetched - 4,111 images is
// not something to download on a Japanese SIM.
var IMG_CACHE = 'tcg-jp-pricer-img-' + VERSION
var IMG_HOST = 'card.yuyu-tei.jp'
var SHELL = ['/', '/manifest.webmanifest']

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // Added one by one: addAll rejects the whole batch if any single URL
      // fails, which would leave us with no shell at all.
      return Promise.all(
        SHELL.map(function (url) {
          return cache.add(new Request(url, { cache: 'reload' })).catch(function () {})
        })
      )
    })
  )
  self.skipWaiting()
})

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (k) {
            return k === CACHE || k === IMG_CACHE ? null : caches.delete(k)
          })
        )
      })
      .then(function () {
        return self.clients.claim()
      })
  )
})

function shellRequest() {
  return new Request(new URL('/', self.location.origin).toString())
}

function putIfOk(cache, request, response) {
  if (response && response.ok && response.type === 'basic') {
    cache.put(request, response.clone()).catch(function () {})
  }
  return response
}

self.addEventListener('fetch', function (event) {
  var request = event.request

  if (request.method !== 'GET') return

  var url
  try {
    url = new URL(request.url)
  } catch (e) {
    return
  }
  if (url.hostname === IMG_HOST) {
    // Cache-first. An opaque response is unreadable to us but renders fine in
    // an <img>, which is all we need.
    event.respondWith(
      caches.open(IMG_CACHE).then(function (cache) {
        return cache.match(request).then(function (cached) {
          if (cached) return cached
          return fetch(request)
            .then(function (response) {
              if (response && (response.ok || response.type === 'opaque')) {
                cache.put(request, response.clone()).catch(function () {})
              }
              return response
            })
            .catch(function () {
              return cached || Response.error()
            })
        })
      })
    )
    return
  }

  if (url.origin !== self.location.origin) return
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  if (request.mode === 'navigate') {
    // Every navigation resolves to the one page this app has.
    var shell = shellRequest()
    event.respondWith(
      caches.open(CACHE).then(function (cache) {
        return cache.match(shell).then(function (cached) {
          var network = fetch(shell)
            .then(function (response) {
              return putIfOk(cache, shell, response)
            })
            .catch(function () {
              return null
            })

          if (cached) {
            event.waitUntil(network)
            return cached
          }
          return network.then(function (response) {
            if (response) return response
            return new Response(
              '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
                '<body style="background:#000;color:#fff;font:17px system-ui;padding:24px">' +
                '<h1>Offline, and nothing cached yet</h1>' +
                '<p>Open this page once while you have signal. After that it works with the radio off.</p>',
              { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            )
          })
        })
      })
    )
    return
  }

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(request).then(function (cached) {
        if (cached) return cached
        return fetch(request)
          .then(function (response) {
            return putIfOk(cache, request, response)
          })
          .catch(function () {
            return Response.error()
          })
      })
    })
  )
})
