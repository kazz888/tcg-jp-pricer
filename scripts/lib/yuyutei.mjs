// Yuyu-tei (yuyu-tei.jp) scraper for the One Piece Card Game ("opc").
//
// Pure library: importing this file performs NO network I/O and has no side
// effects. The CLI entry point is scripts/pull-yuyutei.mjs.
//
// PARSING TRAP: Yuyu-tei's HTML is minified with newlines INSIDE tags, e.g.
//   <div\nclass="card-product position-relative ...">
// so any regex like /<div class="card-product"/ matches ZERO rows. Everything
// here goes through cheerio, which tokenises properly.

import * as cheerio from 'cheerio'

/** Undamaged inventory only. kizu=1 is a SEPARATE damaged inventory - never mix. */
export const SELL_BASE = 'https://yuyu-tei.jp/sell/opc/s/search?kizu=0'
export const BUY_BASE = 'https://yuyu-tei.jp/buy/opc/s/search?kizu=0'

/** Measured 2026: 8 sell pages (600/page, 4784 rows), 4 buy pages (1950 rows). */
export const EXPECTED = {
  sellPages: 8,
  buyPages: 4,
  sellRows: 4784,
  buyRows: 1950,
  perPage: 600,
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Card codes we accept. "-" is a DON!! card, which genuinely has no code. */
export const CODE_RE = /^(?:[A-Z]{2,4}\d{2}-\d{3}|P-\d{3}|-)$/

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function pageUrl(side, page) {
  const base = side === 'buy' ? BUY_BASE : SELL_BASE
  return page <= 1 ? base : `${base}&page=${page}`
}

/**
 * Fetch one page as text, retrying with exponential backoff + jitter.
 * Throws only after every attempt fails.
 */
export async function fetchPage(url, { retries = 4, timeoutMs = 30000, log } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en-US;q=0.8,en;q=0.7',
        },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const html = await res.text()
      if (!html || html.length < 1000) {
        throw new Error(`suspiciously short body (${html.length} bytes)`)
      }
      return html
    } catch (err) {
      lastErr = err
      if (attempt === retries) break
      const backoff = Math.round(1000 * 2 ** (attempt - 1) * (1 + Math.random() * 0.3))
      log?.(`    retry ${attempt}/${retries - 1} after ${backoff}ms - ${err.message}`)
      await sleep(backoff)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`failed to fetch ${url}: ${lastErr?.message ?? 'unknown error'}`)
}

/** "1,480,000 円" -> 1480000. Returns null when no price is present. */
export function parseJpy(text) {
  if (!text) return null
  const m = /([\d,]+)\s*円/.exec(text)
  if (!m) return null
  const n = Number.parseInt(m[1].replace(/,/g, ''), 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Split trailing parenthetical variant markers off the card name.
 *
 * Names can stack several markers, and 737/4784 rows do:
 *   "モンキー・D・ルフィ(パラレル)(レッドスーパーパラレル)"
 *     -> baseName "モンキー・D・ルフィ"
 *        variants ["パラレル", "レッドスーパーパラレル"]
 *        variant  "レッドスーパーパラレル"
 *
 * These are exactly the rows where getting the printing wrong is most expensive
 * (that card sells for 1,480,000 JPY while the plain (パラレル)(スーパーパラレル)
 * twin of the same code sells for 178,000), so we keep EVERY marker. `variant`
 * is the contract's single string and holds the most specific (last) marker;
 * `variants` carries the full list for disambiguation downstream.
 *
 * Handles both ASCII () and full-width （）.
 */
export function parseVariant(name) {
  const re = /^(.*?)\s*[(（]([^()（）]+)[)）]\s*$/
  let rest = name
  const variants = []
  for (;;) {
    const m = re.exec(rest)
    if (!m) break
    variants.unshift(m[2].trim())
    rest = m[1].trim()
  }
  return {
    baseName: rest,
    variants,
    variant: variants.length ? variants[variants.length - 1] : null,
  }
}

/**
 * Derive the SET from the card code. Never from setBucket: Yuyu-tei's bucket is
 * a listing bucket and disagrees with the code on ~9% of rows.
 * "OP17-118" -> "OP17", "PRB01-001" -> "PRB01", "P-003" -> "P", "-" -> null.
 */
export function setCodeFromCardCode(code) {
  if (!code || code === '-') return null
  let m = /^([A-Z]{2,4}\d{2})-\d{3}$/.exec(code)
  if (m) return m[1]
  if (/^P-\d{3}$/.test(code)) return 'P'
  return null
}

/**
 * Parse one search-results page into raw rows.
 *
 * Rarity is taken from the 2nd token of the image alt ("<CODE> <RARITY> <NAME>")
 * and cross-checked against the most recent preceding section header; both are
 * returned so the caller can report drift.
 */
export function parsePage(html, side = 'sell') {
  const $ = cheerio.load(html)
  const rows = []

  // Combined selector yields document order, so the last header seen before a
  // block is that block's section.
  let currentHeader = null
  $('h3.text-primary.fs-4.shadow.fw-bold, div.card-product').each((_i, el) => {
    const $el = $(el)
    if (el.tagName === 'h3') {
      const span = $el.find('span').first().text().trim()
      currentHeader = (span || $el.text().replace(/\s*Card List\s*$/, '').trim()) || null
      return
    }

    const cls = $el.attr('class') || ''
    const code = $el.find('span.d-block.border.border-dark').first().text().trim()
    const name = $el.find('h4.text-primary.fw-bold').first().text().trim()
    const $img = $el.find('img.card.img-fluid').first()
    const alt = ($img.attr('alt') || '').trim()

    const altTokens = alt.split(/\s+/)
    const altCode = altTokens[0] ?? ''
    const rarityFromAlt = altTokens[1] ?? ''

    const priceText = $el.find('strong.d-block.text-end').first().text()
    const price = parseJpy(priceText)

    const prevText = $el.find('small.d-block.text-end.fs-9 > del').first().text()
    const prev = parseJpy(prevText)

    const cardId = $el.find('input.cart_cid').first().attr('value') ?? ''
    const setBucket = $el.find('input.cart_ver').first().attr('value') ?? ''
    const limitRaw = $el.find('input.cart_limit').first().attr('value')
    const stock = limitRaw === undefined ? null : Number.parseInt(limitRaw, 10)

    // Sell pages link to /sell/opc/card/...; buy pages use a different href.
    const detailUrl =
      $el.find("a[href^='https://yuyu-tei.jp/sell/opc/card/']").first().attr('href') ??
      $el.find("a[href*='/opc/card/']").first().attr('href') ??
      null

    const { baseName, variant, variants } = parseVariant(name)

    rows.push({
      side,
      code,
      altCode,
      name,
      baseName,
      variant,
      variants,
      rarity: rarityFromAlt,
      rarityFromHeader: currentHeader,
      setCode: setCodeFromCardCode(code),
      setBucket,
      cardId,
      img: $img.attr('src') ?? null,
      detailUrl,
      price,
      prevPrice: prev,
      stock: Number.isFinite(stock) ? stock : null,
      soldOutClass: /\bsold-out\b/.test(cls),
    })
  })

  return rows
}

export const rowKey = (r) => `${r.setBucket}::${r.cardId}`

/**
 * Walk pages of one side until a page yields 0 blocks (or maxPages is hit).
 * Polite: ~1 request/second.
 */
export async function sweep(side, { maxPages = 20, delayMs = 1000, log = () => {} } = {}) {
  const rows = []
  const pageCounts = []
  let pagesFetched = 0

  for (let page = 1; page <= maxPages; page++) {
    const url = pageUrl(side, page)
    log(`  GET ${url}`)
    const html = await fetchPage(url, { log })
    pagesFetched++
    const pageRows = parsePage(html, side)
    pageCounts.push(pageRows.length)
    log(`    -> ${pageRows.length} blocks`)

    if (pageRows.length === 0) {
      // Empty page = end of the catalogue. Do not count it as a data page.
      pagesFetched--
      pageCounts.pop()
      break
    }
    rows.push(...pageRows)

    if (page < maxPages) await sleep(delayMs)
  }

  return { rows, pagesFetched, pageCounts }
}

/**
 * Join buy rows onto sell rows on the verified primary key (setBucket, cardId).
 * Returns the merged rows plus the diagnostics needed for the drift report.
 */
export function joinBuyOntoSell(sellRows, buyRows) {
  const buyByKey = new Map()
  let buyDupes = 0
  for (const b of buyRows) {
    const k = rowKey(b)
    if (buyByKey.has(k)) buyDupes++
    else buyByKey.set(k, b)
  }

  const matchedKeys = new Set()
  const fieldMismatches = []

  const rows = sellRows.map((s) => {
    const b = buyByKey.get(rowKey(s))
    if (b) {
      matchedKeys.add(rowKey(s))
      if (b.code !== s.code || b.name !== s.name) {
        fieldMismatches.push({
          key: rowKey(s),
          sell: { code: s.code, name: s.name },
          buy: { code: b.code, name: b.name },
        })
      }
    }
    return {
      code: s.code,
      name: s.name,
      baseName: s.baseName,
      variant: s.variant,
      variants: s.variants,
      rarity: s.rarity,
      setCode: s.setCode,
      setBucket: s.setBucket,
      cardId: s.cardId,
      img: s.img,
      detailUrl: s.detailUrl,
      jpySell: s.price,
      jpyBuy: b ? b.price : null,
      jpyBuyPrev: b ? b.prevPrice : null,
      inStock: (s.stock ?? 0) > 0,
      stock: s.stock ?? 0,
    }
  })

  const unmatchedBuy = buyRows.filter((b) => !matchedKeys.has(rowKey(b)))

  return { rows, matchedCount: matchedKeys.size, unmatchedBuy, buyDupes, fieldMismatches }
}
