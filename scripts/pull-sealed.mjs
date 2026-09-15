#!/usr/bin/env node
// scripts/pull-sealed.mjs
//
// Reads data/cardmarket-sealed-raw.json (already on disk - this script NEVER
// calls Apify or any other network service), classifies every row, keeps the
// booster boxes and booster packs that sit in confirmed-Japanese expansions,
// derives a set code per expansion from the singles in data/cardmarket.json,
// and writes data/sealed.json.
//
// Every exclusion is printed. A sealed catalogue that silently shrinks is the
// same failure as a wrong price: the user cannot tell the difference between
// "we checked and there is nothing" and "we dropped it".
//
// Exit codes:
//   0  data/sealed.json written (zero items is a legitimate, reported outcome)
//   1  the raw file is missing or unreadable, the expansion map is broken, or
//      the write failed
//
// Usage: node scripts/pull-sealed.mjs [--raw <path>] [--singles <path>]
//                                     [--out <path>] [--dry-run]

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadExpansions, japaneseExpansionIds, writeJsonFile } from './lib/cardmarket.mjs'
import {
  SEALED_KINDS,
  IN_SCOPE_KINDS,
  kindDistribution,
  deriveSetCodes,
  selectSealed,
  buildSealedFile,
} from './lib/sealed.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DATA = resolve(ROOT, 'data')

const say = (line = '') => console.log(line)
const warn = (line) => console.warn(`WARN  ${line}`)

function fail(message) {
  console.error(`\nERROR ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = {
    raw: resolve(DATA, 'cardmarket-sealed-raw.json'),
    singles: resolve(DATA, 'cardmarket.json'),
    out: resolve(DATA, 'sealed.json'),
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--raw') options.raw = resolve(ROOT, argv[++i] ?? fail('--raw needs a path'))
    else if (arg === '--singles') options.singles = resolve(ROOT, argv[++i] ?? fail('--singles needs a path'))
    else if (arg === '--out') options.out = resolve(ROOT, argv[++i] ?? fail('--out needs a path'))
    else if (arg === '--help' || arg === '-h') {
      say('Usage: node scripts/pull-sealed.mjs [--raw <path>] [--singles <path>] [--out <path>] [--dry-run]')
      say('')
      say('  Offline. Reads a raw Cardmarket sealed dump already on disk; never calls an API.')
      process.exit(0)
    } else fail(`unknown argument: ${arg}`)
  }
  return options
}

function readJson(path, label) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${label} is not valid JSON (${path}): ${error.message}`)
  }
}

/** The raw dump is a bare array today; tolerate { rows } / { items } too. */
function rawRowsOf(doc) {
  if (Array.isArray(doc)) return doc
  if (Array.isArray(doc?.rows)) return doc.rows
  if (Array.isArray(doc?.items)) return doc.items
  return null
}

function latestPriceGuideDate(rows) {
  const dates = [...new Set(rows.map((r) => r?.priceGuideDate).filter(Boolean).map(String))].sort()
  return dates.length ? dates[dates.length - 1] : null
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  say('')
  say('=============================================================')
  say(' tcg-jp-pricer :: pull-sealed   (booster boxes + packs only)')
  say('=============================================================')

  // --- raw sealed rows ----------------------------------------------
  const rawDoc = readJson(options.raw, 'sealed raw dump')
  if (rawDoc == null) {
    fail(
      `sealed raw dump is missing: ${options.raw}\n` +
        '      This script does not fetch it. Put the Cardmarket sealed rows there first.',
    )
  }
  const rows = rawRowsOf(rawDoc)
  if (!rows) fail(`${options.raw}: expected an array of rows (or { rows: [...] })`)
  if (rows.length === 0) fail(`${options.raw} contains 0 rows - refusing to write an empty sealed catalogue`)

  // --- expansion languages (reused, never reimplemented) -------------
  const expansions = await loadExpansions()
  const japaneseIds = await japaneseExpansionIds(expansions)

  // --- singles, for the set-code derivation --------------------------
  const singlesDoc = readJson(options.singles, 'data/cardmarket.json')
  const singlesRows = Array.isArray(singlesDoc?.rows) ? singlesDoc.rows : []
  if (singlesRows.length === 0) {
    warn(`${options.singles} has no rows - every sealed item will be written with setCode: null`)
  }
  const setCodes = deriveSetCodes(singlesRows)

  say('')
  say('INPUTS')
  say(`  sealed raw             ${rows.length} rows   ${options.raw.replace(`${ROOT}/`, '')}`)
  say(`  singles                ${singlesRows.length} rows   ${options.singles.replace(`${ROOT}/`, '')}`)
  say(`  expansions             ${expansions.size} mapped, ${japaneseIds.length} confirmed japanese`)

  // --- 1. classification --------------------------------------------
  const distribution = kindDistribution(rows)
  say('')
  say('CLASSIFICATION  (all rows, before any filtering)')
  for (const kind of SEALED_KINDS) {
    const mark = IN_SCOPE_KINDS.includes(kind) ? ' <- in scope' : ''
    say(`  ${kind.padEnd(14)} ${String(distribution.counts[kind]).padStart(4)}${mark}`)
  }
  say(`  ${'TOTAL'.padEnd(14)} ${String(distribution.total).padStart(4)}`)

  if (distribution.unconfident.length > 0) {
    say('')
    say(`  ${distribution.unconfident.length} name(s) the classifier could not place confidently.`)
    say('  All are bucketed OUT OF SCOPE and listed here rather than quietly absorbed:')
    for (const entry of distribution.unconfident) {
      say(`      -> ${entry.kind.padEnd(12)} [${entry.rule}]  ${entry.name}`)
    }
  } else {
    say('  every name placed confidently')
  }

  // --- 2. selection --------------------------------------------------
  const selection = selectSealed({ rows, expansions, setCodes })
  const ex = selection.excluded

  say('')
  say('SELECTION  (japanese expansions only; "unknown" fails closed)')
  say(`  kept                   ${selection.items.length}`)
  say(`  dropped: wrong kind    ${ex.out_of_scope_kind}   (${SEALED_KINDS.filter((k) => !IN_SCOPE_KINDS.includes(k)).map((k) => `${k}=${ex.byKind[k]}`).join(' ')})`)
  say(`  dropped: language      ${ex.language_not_japanese}   (${Object.entries(ex.byLanguage).map(([l, n]) => `${l}=${n}`).join(' ') || 'none'})`)
  say(`  dropped: unknown exp   ${ex.unknown_expansion}   (expansionId we have never mapped -> unknown -> never priced)`)
  say(`  dropped: non-EUR       ${ex.non_eur_currency}`)
  say(`  dropped: no price      ${ex.no_price}   (trend, low and avg7 all null)`)
  say(`  dropped: duplicate id  ${ex.duplicate_product_id}`)
  say(`  dropped: malformed row ${ex.bad_row}`)

  const keptByKind = {}
  for (const item of selection.items) keptByKind[item.kind] = (keptByKind[item.kind] ?? 0) + 1
  say(`  kept by kind           ${IN_SCOPE_KINDS.map((k) => `${k}=${keptByKind[k] ?? 0}`).join('  ')}`)

  // --- 3. set codes ---------------------------------------------------
  const stats = selection.setCodeStats
  say('')
  say('SET CODE DERIVATION  (modal cardCode set per expansion, from the singles)')
  say(`  resolved               ${stats.withSetCode} / ${stats.total}   ${stats.pct}`)
  if (stats.unresolvedExpansions.length > 0) {
    say(`  UNRESOLVED             ${stats.unresolvedExpansions.length} expansion(s) - these items ship with setCode: null`)
    for (const entry of stats.unresolvedExpansions) {
      const detail = setCodes.get(entry.expansionId)
      say(
        `      ${String(entry.expansionId).padEnd(6)} ${String(entry.expansionName ?? '?').slice(0, 40).padEnd(40)} ` +
          `${detail ? detail.reason : 'no_singles_in_this_expansion'}`,
      )
    }
  } else {
    say('  every kept item resolved to a set code')
  }

  // --- 4. collisions --------------------------------------------------
  say('')
  if (selection.collisions.length === 0) {
    say('COLLISIONS  none - every (set code, kind) pair is unique')
  } else {
    say(`COLLISIONS  ${selection.collisions.length} (set code, kind) pair(s) with >1 product.`)
    say('            BOTH are kept. The app shows both rather than picking one.')
    for (const collision of selection.collisions) {
      say(`      ${collision.setCode} ${collision.kind}`)
      for (const item of collision.items) {
        say(`          ${item.productId}  EUR ${item.trendEur ?? '-'}   ${item.name}`)
      }
    }
  }

  // --- 5. write --------------------------------------------------------
  const priceGuideDate = latestPriceGuideDate(rows)
  const payload = buildSealedFile({
    items: selection.items,
    priceGuideDate,
    source: {
      raw: options.raw.replace(`${ROOT}/`, ''),
      rawRows: rows.length,
      singles: options.singles.replace(`${ROOT}/`, ''),
      provider: 'cardmarket price guide (EUR)',
      // Stated in the file itself so nobody downstream has to guess why jpyRef is null.
      jpyReference:
        'none - no Japanese sealed price source exists yet (Yuyu-tei sells no sealed product; ' +
        'Hareruya2 unopened is Pokemon-only; Rakuten needs an applicationId we do not have)',
      inScopeKinds: [...IN_SCOPE_KINDS],
    },
  })

  say('')
  say('SAMPLE  (first 10 kept items)')
  for (const item of selection.items.slice(0, 10)) {
    say(
      `  ${String(item.setCode ?? '-').padEnd(6)} ${item.kind.padEnd(13)} ` +
        `EUR ${String(item.trendEur ?? '-').padStart(7)}   ${item.name}`,
    )
  }

  if (options.dryRun) {
    say('')
    say(`--dry-run: nothing written (would have written ${selection.items.length} items to ${options.out})`)
    return
  }

  try {
    await writeJsonFile(options.out, payload)
  } catch (error) {
    fail(`could not write ${options.out}: ${error.message}`)
  }

  say('')
  say(`WROTE ${options.out}  (${selection.items.length} items, priceGuideDate=${priceGuideDate ?? '?'})`)
  if (selection.items.length === 0) {
    warn('the sealed catalogue is EMPTY - the index will simply carry no sealed products')
  }
  say('')
}

main().catch((error) => {
  console.error(error)
  fail(`unexpected failure: ${error.message}`)
})
