#!/usr/bin/env node
// Pull the full Yuyu-tei One Piece catalogue (sell + buy) into data/yuyutei.json.
//
//   node scripts/pull-yuyutei.mjs            # real run: all 8 sell + 4 buy pages
//   node scripts/pull-yuyutei.mjs --pages 1  # fast smoke test
//
// Everything downstream of this file depends on Yuyu-tei's markup staying put,
// so the run ends with a validation report. If a count materially disagrees with
// the measured spec, we shout about it rather than writing quietly-wrong data.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EXPECTED,
  CODE_RE,
  sweep,
  joinBuyOntoSell,
  rowKey,
} from './lib/yuyutei.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'data', 'yuyutei.json')

function parseArgs(argv) {
  let maxPages = 20
  let delayMs = 1000
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pages') {
      const n = Number.parseInt(argv[++i], 10)
      if (!Number.isFinite(n) || n < 1) {
        console.error('--pages needs a positive integer')
        process.exit(2)
      }
      maxPages = n
    } else if (argv[i] === '--delay') {
      const n = Number.parseInt(argv[++i], 10)
      if (Number.isFinite(n) && n >= 0) delayMs = n
    }
  }
  return { maxPages, delayMs }
}

const log = (...a) => console.log(...a)
const warnings = []
/** Loud, because a silent drift means the whole app is priced off stale markup. */
function loud(msg) {
  warnings.push(msg)
  console.log(`\n!!! ${msg}`)
}

function pct(n, d) {
  return d === 0 ? '0.0%' : `${((n / d) * 100).toFixed(1)}%`
}

async function main() {
  const { maxPages, delayMs } = parseArgs(process.argv.slice(2))
  const partial = maxPages < Math.max(EXPECTED.sellPages, EXPECTED.buyPages)
  const startedAt = Date.now()

  log('Yuyu-tei One Piece pull')
  log(`  mode: ${partial ? `SMOKE TEST (max ${maxPages} page(s)/side)` : 'FULL RUN'}`)
  log(`  polite delay: ${delayMs}ms between requests\n`)

  log('SELL side')
  const sell = await sweep('sell', { maxPages, delayMs, log })
  log(`\nBUY side`)
  const buy = await sweep('buy', { maxPages, delayMs, log })

  const { rows, matchedCount, unmatchedBuy, buyDupes, fieldMismatches } = joinBuyOntoSell(
    sell.rows,
    buy.rows,
  )

  // ---------------------------------------------------------------- validation
  const withCode = rows.filter((r) => r.code && r.code !== '-').length
  const dashCodes = rows.filter((r) => r.code === '-').length
  const badCodes = rows.filter((r) => !CODE_RE.test(r.code))
  const distinctKeys = new Set(sell.rows.map(rowKey)).size
  const soldOut = rows.filter((r) => !r.inStock).length
  const soldOutClass = sell.rows.filter((r) => r.soldOutClass).length
  const stockZero = sell.rows.filter((r) => (r.stock ?? 0) === 0).length
  const noPrice = rows.filter((r) => r.jpySell === null).length
  const noImg = rows.filter((r) => !r.img).length
  const noDetail = rows.filter((r) => !r.detailUrl).length
  const withVariant = rows.filter((r) => r.variant).length
  const multiVariant = rows.filter((r) => (r.variants?.length ?? 0) > 1).length
  const leftoverParen = rows.filter((r) => /[(（][^()（）]*[)）]\s*$/.test(r.baseName))
  const unmappedSet = rows.filter((r) => r.setCode === null).length

  const rarityDist = {}
  for (const r of rows) rarityDist[r.rarity || '(none)'] = (rarityDist[r.rarity || '(none)'] ?? 0) + 1

  const setDist = {}
  for (const r of rows) {
    const k = r.setCode ?? '(none)'
    setDist[k] = (setDist[k] ?? 0) + 1
  }

  const rarityHeaderMismatch = sell.rows.filter(
    (r) => r.rarityFromHeader && r.rarity && r.rarityFromHeader !== r.rarity,
  ).length
  const altCodeMismatch = sell.rows.filter((r) => r.altCode && r.altCode !== r.code).length
  const bucketDisagrees = rows.filter(
    (r) => r.setCode && r.setBucket && r.setCode.toLowerCase() !== r.setBucket.toLowerCase(),
  ).length

  log('\n' + '='.repeat(72))
  log('VALIDATION REPORT')
  log('='.repeat(72))
  log(`sell pages fetched     ${sell.pagesFetched}  (blocks/page: ${sell.pageCounts.join(', ')})`)
  log(`buy  pages fetched     ${buy.pagesFetched}  (blocks/page: ${buy.pageCounts.join(', ')})`)
  log(`sell rows parsed       ${sell.rows.length}`)
  log(`buy  rows parsed       ${buy.rows.length}`)
  log(`output rows            ${rows.length}`)
  log(`rows with a card code  ${withCode}  (${pct(withCode, rows.length)})`)
  log(`DON!! rows (code "-")  ${dashCodes}`)
  log(`invalid codes          ${badCodes.length}`)
  log(`distinct (bucket,id)   ${distinctKeys}`)
  log(`rows with a variant    ${withVariant}  (${pct(withVariant, rows.length)})`)
  log(`  stacked variants     ${multiVariant}  (e.g. "(パラレル)(スーパーパラレル)")`)
  log(`sold out (stock==0)    ${soldOut}  (${pct(soldOut, rows.length)})`)
  log(`  .sold-out class      ${soldOutClass}   cart_limit==0: ${stockZero}`)
  log(`buy-side matched       ${matchedCount} / ${buy.rows.length}  (${pct(matchedCount, buy.rows.length)})`)
  log(`buy rows unmatched     ${unmatchedBuy.length}`)
  log(`missing sell price     ${noPrice}`)
  log(`missing image          ${noImg}`)
  log(`missing detail URL     ${noDetail}`)
  log(`setCode == null        ${unmappedSet}  (DON!!/unparseable)`)
  log(`setBucket != setCode   ${bucketDisagrees}  (expected: we always trust setCode)`)

  log('\nrarity distribution:')
  for (const [k, v] of Object.entries(rarityDist).sort((a, b) => b[1] - a[1])) {
    log(`  ${k.padEnd(8)} ${String(v).padStart(5)}`)
  }

  log('\nset distribution:')
  const sets = Object.entries(setDist).sort((a, b) => b[1] - a[1])
  for (const [k, v] of sets) log(`  ${k.padEnd(8)} ${String(v).padStart(5)}`)

  // ------------------------------------------------------------ drift shouting
  if (badCodes.length > 0) {
    loud(`${badCodes.length} row(s) have a card code that fails ${CODE_RE}. Samples: ` +
      badCodes.slice(0, 5).map((r) => JSON.stringify(r.code)).join(', '))
  }
  if (distinctKeys !== sell.rows.length) {
    loud(`PRIMARY KEY BROKEN: ${sell.rows.length} sell rows but only ${distinctKeys} distinct ` +
      `(setBucket,cardId). The join key is no longer unique - downstream data is unreliable.`)
  }
  if (soldOutClass !== stockZero) {
    loud(`sold-out signals disagree: .sold-out class on ${soldOutClass} rows but cart_limit==0 ` +
      `on ${stockZero}. Spec says these match exactly.`)
  }
  if (noPrice > 0) loud(`${noPrice} row(s) have NO sell price - the price selector may have moved.`)
  if (noImg > 0) loud(`${noImg} row(s) have no image URL.`)
  if (rarityHeaderMismatch > 0) {
    loud(`${rarityHeaderMismatch} row(s) where the section header rarity disagrees with the ` +
      `image-alt rarity. Spec says 0 mismatches.`)
  }
  if (altCodeMismatch > 0) {
    loud(`${altCodeMismatch} row(s) where the image-alt code disagrees with the badge code. ` +
      `Spec says 0 mismatches.`)
  }
  if (leftoverParen.length > 0) {
    loud(`${leftoverParen.length} row(s) still end in a parenthetical after variant extraction - ` +
      `the variant parser missed a marker. Sample: ${JSON.stringify(leftoverParen[0].name)}`)
  }
  if (buyDupes > 0) loud(`${buyDupes} duplicate (setBucket,cardId) key(s) on the buy side.`)
  if (fieldMismatches.length > 0) {
    loud(`${fieldMismatches.length} buy/sell join(s) matched on key but disagree on code or name. ` +
      `Spec says all 1,950 agree. Sample: ${JSON.stringify(fieldMismatches[0])}`)
  }
  if (unmatchedBuy.length > 0) {
    if (partial) {
      // Structurally guaranteed on a smoke test: buy page 1 references cards
      // whose sell rows live on sell pages we deliberately did not fetch.
      log(`\nnote: ${unmatchedBuy.length} buy row(s) matched no sell row - expected on a ` +
        `partial run, their sell rows are on pages we skipped.`)
    } else {
      loud(`${unmatchedBuy.length} buy row(s) matched NO sell row. Spec says all buy rows match.`)
    }
  }

  if (partial) {
    log(`\nNOTE: smoke test (--pages ${maxPages}); totals are not comparable to the full-run spec.`)
  } else {
    if (sell.pagesFetched !== EXPECTED.sellPages) {
      loud(`sell page count drifted: got ${sell.pagesFetched}, spec says ${EXPECTED.sellPages}.`)
    }
    if (buy.pagesFetched !== EXPECTED.buyPages) {
      loud(`buy page count drifted: got ${buy.pagesFetched}, spec says ${EXPECTED.buyPages}.`)
    }
    // A few cards added/sold out day to day is normal; >2% is markup drift.
    const sellDrift = Math.abs(sell.rows.length - EXPECTED.sellRows) / EXPECTED.sellRows
    const buyDrift = Math.abs(buy.rows.length - EXPECTED.buyRows) / EXPECTED.buyRows
    if (sellDrift > 0.02) {
      loud(`SELL ROW COUNT DRIFTED ${(sellDrift * 100).toFixed(1)}%: got ${sell.rows.length}, ` +
        `spec says ${EXPECTED.sellRows}. Verify the markup before trusting this data.`)
    } else if (sell.rows.length !== EXPECTED.sellRows) {
      log(`\nnote: sell rows ${sell.rows.length} vs spec ${EXPECTED.sellRows} ` +
        `(${(sellDrift * 100).toFixed(2)}% - within normal inventory churn).`)
    }
    if (buyDrift > 0.02) {
      loud(`BUY ROW COUNT DRIFTED ${(buyDrift * 100).toFixed(1)}%: got ${buy.rows.length}, ` +
        `spec says ${EXPECTED.buyRows}. Verify the markup before trusting this data.`)
    } else if (buy.rows.length !== EXPECTED.buyRows) {
      log(`\nnote: buy rows ${buy.rows.length} vs spec ${EXPECTED.buyRows} ` +
        `(${(buyDrift * 100).toFixed(2)}% - within normal inventory churn).`)
    }
    if (withCode + dashCodes !== rows.length) {
      loud(`code coverage is not 100%: ${rows.length - withCode - dashCodes} row(s) have neither ` +
        `a code nor the DON!! marker.`)
    }
  }

  // ------------------------------------------------------------------- write
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'yuyu-tei.jp',
    game: 'one-piece',
    partial,
    sourceCounts: {
      sellPages: sell.pagesFetched,
      buyPages: buy.pagesFetched,
      sellRows: sell.rows.length,
      buyRows: buy.rows.length,
    },
    rows,
  }

  await fs.mkdir(path.dirname(OUT), { recursive: true })
  await fs.writeFile(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  const bytes = (await fs.stat(OUT)).size

  log(`\nwrote ${OUT}`)
  log(`  ${rows.length} rows, ${(bytes / 1024 / 1024).toFixed(2)} MB`)
  log(`  elapsed ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)

  if (warnings.length > 0) {
    log('\n' + '!'.repeat(72))
    log(`${warnings.length} WARNING(S) - MARKUP MAY HAVE DRIFTED. DO NOT SHIP BLIND:`)
    for (const w of warnings) log(`  - ${w}`)
    log('!'.repeat(72))
  } else {
    log('\nAll validations passed.')
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exitCode = 1
})
