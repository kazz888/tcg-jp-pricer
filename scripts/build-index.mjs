#!/usr/bin/env node
// scripts/build-index.mjs
//
// Reads data/yuyutei.json + data/cardmarket.json, resolves Cardmarket expansion
// languages (data/expansions.json, overridden by data/expansion-overrides.json),
// joins on card code, bakes the FX rate in, and writes data/index.json
// conforming to PriceIndex in src/lib/types.ts.
//
// Everything the shop-counter UI needs is in that one file: it must work with
// no signal, so no price and no FX lookup ever happens in the browser.
//
// Exit codes:
//   0  index written (a coverage hole is EXPECTED today and only warns)
//   1  pipeline broken - no Yuyu-tei rows, no expansion map, no FX, write failed
//
// Usage: node scripts/build-index.mjs [--offline] [--out <path>] [--fail-on-missing-sets]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildExpansionIndex,
  intersectJapanese,
  indexCardmarketRows,
  joinCards,
  computeCoverage,
  statusBreakdown,
  missingSetDetail,
} from './lib/join.mjs'

import { sealedIndexItems, isUsableSealedFile } from './lib/sealed.mjs'

// Set prefixes kept out of the index entirely. Empty on purpose.
//
// The problem ST was excluded for is a PRESENTATION problem: 28 ST chips made
// the set filter at the top of the search screen unusable. Deleting the rows to
// fix a crowded filter cost 536 SKUs (512 of them in stock) and told anyone who
// searched an ST code "nothing matches", which is a lie. The set filter now
// hides those chips instead - see HIDDEN_SET_PREFIXES in SearchView.tsx - so the
// scroller is clean AND an ST card found in a shop is still searchable by code.
//
// Add a prefix here only to drop rows from the data for a real data reason.
const EXCLUDED_SET_PREFIXES = []

// Keyed on the LISTING bucket, not the card code. 208 ST-coded cards are sold
// out of prb01/prb02 (Premium Booster) buckets - those are booster singles, not
// starter-deck contents, and excluding them would be wrong by the same logic
// that excludes the decks.
function isExcludedRow(row) {
  const bucket = String(row?.setBucket ?? '')
  const prefix = bucket.replace(/[0-9]+$/, '').toUpperCase()
  return EXCLUDED_SET_PREFIXES.includes(prefix)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DATA = resolve(ROOT, 'data')

const FX_ENDPOINT = 'https://open.er-api.com/v6/latest/EUR'

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = { offline: false, out: resolve(DATA, 'index.json'), failOnMissingSets: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--offline') options.offline = true
    else if (arg === '--fail-on-missing-sets') options.failOnMissingSets = true
    else if (arg === '--out') {
      const next = argv[++i]
      if (!next) fail('--out needs a path')
      options.out = resolve(ROOT, next)
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: node scripts/build-index.mjs [options]',
          '',
          '  --offline                 do not call the FX API (needs FX_JPY_EUR or a previous index.json)',
          '  --out <path>              write somewhere other than data/index.json',
          '  --fail-on-missing-sets    exit 1 when Yuyu-tei sells a set we cannot price (CI gate; off by default,',
          '                            because OP14-OP17 are a known, expected hole right now)',
        ].join('\n'),
      )
      process.exit(0)
    } else {
      fail(`unknown argument: ${arg}`)
    }
  }
  return options
}

/* ------------------------------------------------------------------ *
 * Output helpers
 * ------------------------------------------------------------------ */

const say = (line = '') => console.log(line)
const warn = (line) => console.warn(`WARN  ${line}`)

function fail(message) {
  console.error(`\nERROR ${message}\n`)
  process.exit(1)
}

function banner(title, lines, char = '!') {
  const rule = char.repeat(74)
  say('')
  say(rule)
  say(`${char}${char}  ${title}`)
  say(rule)
  for (const line of lines) say(`${char}${char}  ${line}`)
  say(rule)
  say('')
}

function readJson(path, { required, label }) {
  if (!existsSync(path)) {
    if (required) fail(`${label} is missing: ${path}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (required) fail(`${label} is not valid JSON (${path}): ${error.message}`)
    warn(`${label} is not valid JSON, ignoring it (${path}): ${error.message}`)
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Env (FX override only - no secret is ever read, printed or written here)
 * ------------------------------------------------------------------ */

function fxOverrideFromEnv() {
  const read = () => {
    const raw = process.env.FX_JPY_EUR
    if (raw === undefined || String(raw).trim() === '') return null
    const parsed = Number(String(raw).trim())
    return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN
  }
  let value = read()
  if (value === null) {
    const envFile = resolve(ROOT, '.env')
    if (existsSync(envFile)) {
      try {
        process.loadEnvFile(envFile)
      } catch {
        /* a malformed .env must never break the build; the API call covers us */
      }
      value = read()
    }
  }
  if (Number.isNaN(value)) {
    warn('FX_JPY_EUR is set but is not a positive number - ignoring it')
    return null
  }
  return value
}

/* ------------------------------------------------------------------ *
 * FX - fetched at build time, baked into the index, never called at runtime
 * ------------------------------------------------------------------ */

async function fetchFx() {
  const response = await fetch(FX_ENDPOINT, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json()
  if (body?.result !== 'success') throw new Error(`api result=${body?.result}`)
  const jpyPerEur = Number(body?.rates?.JPY)
  if (!Number.isFinite(jpyPerEur) || jpyPerEur <= 0) throw new Error('no usable JPY rate in response')
  const stamp = body?.time_last_update_unix
    ? new Date(Number(body.time_last_update_unix) * 1000)
    : new Date()
  return {
    jpyPerEur: Math.round(jpyPerEur * 10000) / 10000,
    source: 'open.er-api.com (JPY per 1 EUR)',
    date: stamp.toISOString().slice(0, 10),
  }
}

async function resolveFx({ offline, previousIndex }) {
  const override = fxOverrideFromEnv()
  if (override !== null) {
    return {
      jpyPerEur: override,
      source: 'FX_JPY_EUR override (.env)',
      date: new Date().toISOString().slice(0, 10),
    }
  }
  if (!offline) {
    try {
      return await fetchFx()
    } catch (error) {
      warn(`FX fetch failed (${error.message}) - falling back to the previous index`)
    }
  }
  const stale = previousIndex?.fx
  if (stale && Number.isFinite(Number(stale.jpyPerEur)) && Number(stale.jpyPerEur) > 0) {
    warn(`reusing STALE FX from the previous index: ${stale.jpyPerEur} JPY/EUR dated ${stale.date}`)
    return {
      jpyPerEur: Number(stale.jpyPerEur),
      source: `${stale.source} [STALE: reused, live rate unavailable]`,
      date: String(stale.date ?? ''),
    }
  }
  fail(
    'no FX rate available: the API is unreachable, FX_JPY_EUR is not set, and there is no previous index.json to reuse.\n' +
      '      Set FX_JPY_EUR=<JPY per 1 EUR> in .env and re-run.',
  )
}

/* ------------------------------------------------------------------ *
 * Optional sibling module (written in parallel). Fail-closed by design.
 * ------------------------------------------------------------------ */

const LANGUAGE_EXPORTS = [
  'loadExpansions',
  'buildExpansionIndex',
  'loadExpansionIndex',
  'resolveExpansionLanguages',
  'expansionLanguageIndex',
  'expansionLanguages',
]

function coerceLanguageIndex(value) {
  const entries = value instanceof Map ? [...value.entries()] : value && typeof value === 'object' ? Object.entries(value) : []
  const index = new Map()
  for (const [key, meta] of entries) {
    const expansionId = Number(key)
    if (!Number.isInteger(expansionId)) continue
    const language = typeof meta === 'string' ? meta : meta?.language
    if (typeof language !== 'string') continue
    index.set(expansionId, {
      expansionId,
      name: String(meta?.name ?? ''),
      language,
      source: 'scripts/lib/cardmarket.mjs',
      why: null,
    })
  }
  return index
}

/**
 * If scripts/lib/cardmarket.mjs exposes an expansion-language index, use it as a
 * SECOND opinion only: an expansion stays eligible only where both it and our
 * own reading of the JSON say 'japanese'. The sibling module can therefore only
 * ever remove eligibility, never add a printing we have not verified ourselves.
 */
async function loadSiblingLanguageIndex() {
  const modulePath = resolve(HERE, 'lib/cardmarket.mjs')
  if (!existsSync(modulePath)) return { index: null, note: 'scripts/lib/cardmarket.mjs absent - reading the JSON directly' }
  try {
    const module = await import(pathToFileURL(modulePath).href)
    for (const name of LANGUAGE_EXPORTS) {
      const exported = module[name]
      let value = exported
      if (typeof exported === 'function') {
        if (exported.length > 0) continue // needs arguments we would have to guess
        value = await exported()
      }
      if (!value) continue
      const index = coerceLanguageIndex(value?.index ?? value)
      if (index.size > 0) {
        return { index, note: `scripts/lib/cardmarket.mjs -> ${name}() (${index.size} expansions, used as a fail-closed second opinion)` }
      }
    }
    return { index: null, note: 'scripts/lib/cardmarket.mjs has no usable language index - reading the JSON directly' }
  } catch (error) {
    return { index: null, note: `scripts/lib/cardmarket.mjs could not be imported (${error.message}) - reading the JSON directly` }
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2))

  say('')
  say('=============================================================')
  say(' tcg-jp-pricer :: build-index   (One Piece, Japanese only)')
  say('=============================================================')

  // --- inputs -------------------------------------------------------
  const yuyuteiPath = resolve(DATA, 'yuyutei.json')
  const cardmarketPath = resolve(DATA, 'cardmarket.json')

  const yuyutei = readJson(yuyuteiPath, { required: true, label: 'data/yuyutei.json' })
  const yuyuteiRows = Array.isArray(yuyutei?.rows) ? yuyutei.rows : null
  if (!yuyuteiRows) fail('data/yuyutei.json has no `rows` array - run `pnpm pull:yuyutei` first')
  if (yuyuteiRows.length === 0) fail('data/yuyutei.json contains 0 rows - the scrape failed, refusing to build an empty index')

  const excludedRows = yuyuteiRows.filter((r) => isExcludedRow(r))
  const keptRows = yuyuteiRows.filter((r) => !isExcludedRow(r))
  if (keptRows.length === 0) fail('every row was excluded by EXCLUDED_SET_PREFIXES - refusing to build an empty index')

  const cardmarket = readJson(cardmarketPath, { required: false, label: 'data/cardmarket.json' })
  const cardmarketUnusable = cardmarket?.truncated === true || cardmarket?.usable === false
  const cardmarketRows = cardmarketUnusable ? null : Array.isArray(cardmarket?.rows) ? cardmarket.rows : null

  // Sealed is OPTIONAL. Its absence is a normal state (it is a separate,
  // hand-run pull) and must degrade to "no sealed products", never to a failure
  // and never to a partial singles build.
  const sealedPath = resolve(DATA, 'sealed.json')
  const sealedDoc = readJson(sealedPath, { required: false, label: 'data/sealed.json' })
  const sealed = isUsableSealedFile(sealedDoc) ? sealedIndexItems(sealedDoc) : []

  const expansionsDoc = readJson(resolve(DATA, 'expansions.json'), { required: true, label: 'data/expansions.json' })
  const overridesDoc = readJson(resolve(DATA, 'expansion-overrides.json'), { required: false, label: 'data/expansion-overrides.json' })

  say('')
  say('INPUTS')
  say(`  data/yuyutei.json      ${yuyuteiRows.length} rows   generatedAt=${yuyutei?.generatedAt ?? '?'}`)
  if (excludedRows.length) {
    const bySet = {}
    for (const r of excludedRows) {
      const k = String(r.code).split('-')[0]
      bySet[k] = (bySet[k] ?? 0) + 1
    }
    const top = Object.entries(bySet).sort((a, b) => b[1] - a[1])
    say(`  excluded by prefix     ${excludedRows.length} rows  [${EXCLUDED_SET_PREFIXES.join(', ')}]  ${top.length} sets`)
    say(`                         e.g. ${top.slice(0, 6).map(([k, n]) => `${k}=${n}`).join(' ')}`)
    say('                         (starter-deck singles; set EXCLUDED_SET_PREFIXES=[] to restore)')
  }
  if (cardmarketRows) {
    say(`  data/cardmarket.json   ${cardmarketRows.length} rows   priceGuideDate=${cardmarket?.priceGuideDate ?? '?'}  truncated=${cardmarket?.truncated === true}`)
  } else {
    say('  data/cardmarket.json   ABSENT -> every card gets euStatus "not_pulled"')
  }
  if (sealedDoc == null) {
    say('  data/sealed.json       ABSENT -> no sealed products in the index (run `pnpm pull:sealed`)')
  } else if (sealed.length === 0) {
    say('  data/sealed.json       present but EMPTY -> no sealed products in the index')
  } else {
    say(`  data/sealed.json       ${sealed.length} items   priceGuideDate=${sealedDoc?.priceGuideDate ?? '?'}`)
  }

  // --- expansion languages -----------------------------------------
  const own = buildExpansionIndex(expansionsDoc, overridesDoc)
  const sibling = await loadSiblingLanguageIndex()
  let expansionIndex = own.index
  let disagreements = []
  if (sibling.index) {
    const merged = intersectJapanese(own.index, sibling.index)
    expansionIndex = merged.index
    disagreements = merged.disagreements
  }

  const languageCounts = {}
  for (const meta of expansionIndex.values()) {
    languageCounts[meta.language] = (languageCounts[meta.language] ?? 0) + 1
  }

  say('')
  say('EXPANSION LANGUAGE MAP  (only "japanese" is ever priced; "unknown" fails closed)')
  say(`  source                 ${sibling.note}`)
  say(
    `  languages              japanese=${languageCounts.japanese ?? 0}  english_confirmed=${languageCounts.english_confirmed ?? 0}  unknown=${languageCounts.unknown ?? 0}`,
  )
  say(`  overrides applied      ${own.applied.length}`)
  for (const entry of own.applied) {
    say(`      ${entry.expansionId}  ${entry.from} -> ${entry.to}   ${entry.name}${entry.why ? `   (${entry.why})` : ''}`)
  }
  if (own.rejected.length > 0) {
    warn(`${own.rejected.length} malformed override(s) in data/expansion-overrides.json - forced to "unknown" (fail closed):`)
    for (const entry of own.rejected) say(`      ${entry.key}: ${entry.why}`)
  }
  if (disagreements.length > 0) {
    warn(`${disagreements.length} expansion(s) where scripts/lib/cardmarket.mjs and the JSON disagree - kept UNPRICED:`)
    for (const entry of disagreements) {
      say(`      ${entry.expansionId}  json=${entry.primary}  cardmarket.mjs=${entry.secondary}   ${entry.name}`)
    }
  }

  // --- join ---------------------------------------------------------
  const cardmarketIndex = cardmarketRows ? indexCardmarketRows(cardmarketRows, expansionIndex) : null
  const cards = joinCards({ yuyuteiRows: keptRows, cardmarketIndex })
  const coverage = computeCoverage(cards, cardmarketIndex)
  const statuses = statusBreakdown(cards)

  if (cardmarketIndex) {
    const stats = cardmarketIndex.stats
    say('')
    say('CARDMARKET ROWS')
    say(`  in                     ${stats.rowsIn}`)
    say(`  kept (japanese)        ${stats.eligible}  across ${stats.eligibleExpansions.size} expansions, ${cardmarketIndex.byCode.size} distinct codes`)
    say(`  dropped: language      ${stats.rejectedLanguage}   (${Object.entries(stats.byLanguage).filter(([lang]) => lang !== 'japanese').map(([lang, n]) => `${lang}=${n}`).join(' ') || 'none'})`)
    say(`  dropped: no code       ${stats.rejectedNoCode}   (no "(OP09-119)" in the product name)`)
    say(`  dropped: duplicate row ${stats.duplicateProductRows}   (same productId twice - would fake an ambiguity)`)
    if (stats.unknownExpansionId > 0) {
      say(`  rows in expansions we have never seen: ${stats.unknownExpansionId}  -> treated as "unknown", never priced`)
    }
  }

  // --- sealed --------------------------------------------------------
  if (sealed.length > 0) {
    const byKind = {}
    for (const item of sealed) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
    const withSetCode = sealed.filter((item) => item.setCode != null).length
    say('')
    say('SEALED  (booster boxes + booster packs, confirmed-Japanese expansions only)')
    say(`  items                  ${sealed.length}   ${Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join('  ')}`)
    say(`  with a set code        ${withSetCode} / ${sealed.length}`)
    say('  jpyRef                 null on every item - there is NO Japanese sealed price source.')
    say('                         The sealed screen must NOT render a good/bad verdict: it has')
    say('                         only the European side, unlike a single.')
  }

  // --- FX -----------------------------------------------------------
  const previousIndex = readJson(options.out, { required: false, label: 'previous index.json' })
  const fx = await resolveFx({ offline: options.offline, previousIndex })

  // --- report -------------------------------------------------------
  const multi = [...(cardmarketIndex?.byCode?.entries() ?? [])].filter(([, list]) => list.length > 1)

  say('')
  say('JOIN RESULT')
  say(`  cards                  ${coverage.cardsTotal}`)
  say(`  ok (1 printing)        ${statuses.ok}`)
  say(`  AMBIGUOUS (>1)         ${statuses.ambiguous}   <- UI must show every candidate, never one number`)
  say(`  unmapped_set           ${statuses.unmapped_set}   <- no verified Japanese expansion for that set`)
  say(`  no_match               ${statuses.no_match}   <- set is priceable, this code is not in it (incl. DON!! / uncoded SKUs)`)
  say(`  not_pulled             ${statuses.not_pulled}`)
  say(`  codes with >1 printing ${multi.length} of ${cardmarketIndex?.byCode?.size ?? 0} japanese codes`)
  for (const [code, list] of multi.slice(0, 5)) {
    say(`      ${code}: ${list.map((candidate) => `${candidate.productId}${candidate.trendEur === null ? '' : ` (EUR ${candidate.trendEur})`}`).join('  ')}`)
  }
  if (multi.length > 5) say(`      ... and ${multi.length - 5} more`)

  say('')
  say('FX  (baked in; the browser never calls an FX API)')
  say(`  1 EUR = ${fx.jpyPerEur} JPY   source=${fx.source}   date=${fx.date}`)

  say('')
  say('COVERAGE')
  say(`  Yuyu-tei is selling    ${coverage.yuyuteiSets.length} sets: ${coverage.yuyuteiSets.join(' ') || '(none)'}`)
  say(`  we can price           ${coverage.mappedSets.length} sets: ${coverage.mappedSets.join(' ') || '(none)'}`)
  say(`  cards with a EUR ref   ${coverage.cardsWithEu} / ${coverage.cardsTotal}`)

  if (!cardmarketRows) {
    banner('data/cardmarket.json IS MISSING - NO EUROPEAN PRICES AT ALL', [
      'Every card was written with euStatus "not_pulled".',
      'The Japanese verdict (Yuyu-tei) still works and is the primary anchor.',
      'Run `pnpm pull:cardmarket` and re-run `pnpm build:index` to fill this in.',
    ])
  }

  if (coverage.missingSets.length > 0) {
    const detail = missingSetDetail(cards, coverage)
    banner(`${coverage.missingSets.length} SET(S) ON SALE AT YUYU-TEI CANNOT BE PRICED IN EUR`, [
      `missing: ${coverage.missingSets.join('  ')}`,
      '',
      ...detail.map(
        (entry) => `${entry.setCode.padEnd(8)} ${String(entry.cards).padStart(5)} SKUs   ${String(entry.inStock).padStart(5)} in stock`,
      ),
      '',
      ...(cardmarketRows
        ? [
            'These cards get euStatus "unmapped_set" and NO euro figure. That is deliberate:',
            'a set is unpriceable when no Cardmarket expansion carrying its cards is confirmed',
            'Japanese. OP14-OP17 appear only as "(Asia Region Legal)", which is not, on its own,',
            'established to mean Japanese - it may be an English-language Asia print.',
            'Falling back to an English or unknown printing would put a wrong number in front',
            'of someone standing at a counter with cash in hand.',
            '',
            'FIX: verify the expansions in a browser (docs/MAPPING.md) and add them to',
            'data/expansion-overrides.json with language "japanese". Re-run this script;',
            'no code change is needed - the override is honoured automatically.',
          ]
        : [
            'CAUSE: data/cardmarket.json was not read, so nothing at all is priceable yet.',
            'This list is not a mapping problem - run `pnpm pull:cardmarket` first.',
          ]),
    ])
  } else {
    say('  -> every set Yuyu-tei sells has a verified Japanese expansion.')
  }

  if (cardmarket?.truncated === true) {
    warn('data/cardmarket.json is marked truncated:true - some sets may look unpriceable purely because their rows were never pulled.')
  }

  // --- write --------------------------------------------------------
  const index = {
    generatedAt: new Date().toISOString(),
    game: 'one-piece',
    fx,
    coverage,
    cards,
    // Always written, even when empty, so the UI has one shape to read.
    sealed,
  }

  try {
    mkdirSync(dirname(options.out), { recursive: true })
    writeFileSync(options.out, JSON.stringify(index), 'utf8')
  } catch (error) {
    fail(`could not write ${options.out}: ${error.message}`)
  }

  const bytes = Buffer.byteLength(JSON.stringify(index))
  say('')
  say(`WROTE ${options.out}  (${(bytes / 1024 / 1024).toFixed(2)} MB, ${cards.length} cards, ${sealed.length} sealed)`)

  if (options.failOnMissingSets && coverage.missingSets.length > 0) {
    fail(`--fail-on-missing-sets: ${coverage.missingSets.length} unpriceable set(s): ${coverage.missingSets.join(' ')}`)
  }

  say('')
  say(
    coverage.missingSets.length > 0
      ? 'DONE with a known coverage hole (expected today). Exit 0 - the build is not broken.'
      : 'DONE. Full coverage.',
  )
  say('')
}

main().catch((error) => {
  console.error(error)
  fail(`unexpected failure: ${error.message}`)
})
