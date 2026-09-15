#!/usr/bin/env node
// scripts/pull-cardmarket.mjs
//
// CLI: pull European (Cardmarket) prices for confirmed-Japanese One Piece expansions and
// write data/cardmarket.json.
//
// SAFETY POSTURE
//   - Only expansions whose language is 'japanese' are ever requested or kept.
//   - A result that cannot be PROVEN complete is truncated, and a truncated pull is NOT
//     published: data/cardmarket.json is left untouched (or absent), so build-index degrades
//     to euStatus 'not_pulled' instead of pricing from a partial set.
//   - Every Apify run costs money, so the default mode touches the network zero times.
//
// USAGE
//   node scripts/pull-cardmarket.mjs                 # dry run: plan only, no network, no cost
//   node scripts/pull-cardmarket.mjs --self-test     # offline unit checks
//   node scripts/pull-cardmarket.mjs --probe         # 1 run: prove the client + read true totals
//   node scripts/pull-cardmarket.mjs --live          # real pull (needs a paid Apify plan)
//
// FLAGS
//   --live                 actually call Apify and write data/cardmarket.json
//   --probe                spend one run on a single expansion, report the true match count
//                          from the run log, write nothing to data/
//   --self-test            run offline assertions and exit
//   --expansion <ids>      comma-separated expansion ids (default: all Japanese ones)
//   --search <q>           actor searchQuery (probe only; narrows the result set)
//   --max-items <n>        actor maxItems per run (default 1000)
//   --max-runs <n>         hard ceiling on Apify runs (default 1 for --probe, 40 for --live)
//   --row-cap <n>          plan row cap used for truncation detection (default 5 = free plan)
//   --allow-truncated      publish anyway, with truncated:true (debug only — see the warning)
//   --out <path>           output file (default data/cardmarket.json)
//   --json                 machine-readable summary on stdout
//
// Secrets: reads APIFY_TOKEN from the environment or .env. Never printed.

import path from 'node:path'
import { existsSync } from 'node:fs'

import {
  APIFY_ACTOR,
  FREE_PLAN_ROW_CAP,
  PATHS,
  REPO_ROOT,
  RunBudget,
  ApifyError,
  BudgetExhaustedError,
  ExpansionDataError,
  apifyToken,
  assessCompleteness,
  buildCardmarketFile,
  buildCodeIndex,
  codeHitRate,
  extractCardCode,
  fetchLastRunMeta,
  fetchRunLog,
  isUsablePriceData,
  japaneseExpansionIds,
  languageStats,
  loadExpansions,
  parseDeliveredCounts,
  partitionRows,
  priceGuideDateOf,
  pullExpansion,
  readCardmarketFile,
  redactSecrets,
  runPriceGuide,
  setCodeOf,
  writeJsonFile,
  DEFAULT_INPUT,
} from './lib/cardmarket.mjs'

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {
    live: false,
    probe: false,
    selfTest: false,
    json: false,
    allowTruncated: false,
    expansions: null,
    search: null,
    maxItems: 1000,
    maxRuns: null,
    rowCap: FREE_PLAN_ROW_CAP,
    out: PATHS.out,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`${arg} needs a value`)
      i += 1
      return v
    }
    switch (arg) {
      case '--live': flags.live = true; break
      case '--probe': flags.probe = true; break
      case '--self-test': flags.selfTest = true; break
      case '--json': flags.json = true; break
      case '--allow-truncated': flags.allowTruncated = true; break
      case '--dry-run': flags.live = false; break
      case '--expansion':
      case '--expansions':
        flags.expansions = next().split(',').map((s) => Number(s.trim())).filter(Number.isInteger)
        break
      case '--search': flags.search = next(); break
      case '--max-items': flags.maxItems = Number(next()); break
      case '--max-runs': flags.maxRuns = Number(next()); break
      case '--row-cap': flags.rowCap = Number(next()); break
      case '--out': flags.out = path.resolve(next()); break
      case '-h':
      case '--help': flags.help = true; break
      default:
        throw new Error(`unknown flag: ${arg}`)
    }
  }
  if (flags.maxRuns == null) flags.maxRuns = flags.probe ? 1 : 40
  return flags
}

function loadDotEnv() {
  const envFile = path.join(REPO_ROOT, '.env')
  if (!existsSync(envFile)) return false
  try {
    // Node >= 20.12. Values are never logged.
    process.loadEnvFile(envFile)
    return true
  } catch {
    return false
  }
}

const log = (...a) => console.log(...a)
const warn = (...a) => console.error(...a)

// ---------------------------------------------------------------------------
// offline self-test
// ---------------------------------------------------------------------------

async function selfTest() {
  const failures = []
  const eq = (actual, expected, label) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a !== e) failures.push(`${label}: expected ${e}, got ${a}`)
  }

  // --- extractCardCode ---
  eq(extractCardCode('Monkey.D.Luffy (OP09-119)'), 'OP09-119', 'code: plain')
  eq(extractCardCode('Sanji (ST01-007)'), 'ST01-007', 'code: starter deck')
  eq(extractCardCode('Shanks (EB01-006)'), 'EB01-006', 'code: extra booster')
  eq(extractCardCode('Nami (PRB01-012)'), 'PRB01-012', 'code: premium booster')
  eq(extractCardCode('Roronoa Zoro (P-001)'), 'P-001', 'code: promo')
  eq(extractCardCode('Monkey.D.Luffy (op09-119)'), 'OP09-119', 'code: lower-case is upper-cased')
  eq(extractCardCode('DON!! Card'), null, 'code: DON card has none')
  eq(extractCardCode('Portgas.D.Ace'), null, 'code: no code at all')
  eq(extractCardCode(''), null, 'code: empty')
  eq(extractCardCode(null), null, 'code: null')
  eq(extractCardCode('Booster Box OP09'), null, 'code: set code alone is not a card code')
  eq(extractCardCode('Luffy (OP09-1191)'), null, 'code: 4-digit number rejected')
  eq(extractCardCode('Luffy (OP9-119)'), null, 'code: 1-digit set rejected')
  eq(extractCardCode('Luffy (OP09-11)'), null, 'code: 2-digit number rejected')
  eq(extractCardCode('Combo OP09-119 / OP09-120'), null, 'code: two codes -> refuse to guess')
  eq(extractCardCode('Alt art of OP09-119 (OP09-120)'), 'OP09-120', 'code: parenthesised wins')
  eq(extractCardCode('Luffy (OP09-119) (V.2)'), 'OP09-119', 'code: trailing variant paren ok')
  eq(setCodeOf('OP09-119'), 'OP09', 'setCodeOf')
  eq(setCodeOf('P-001'), 'P', 'setCodeOf promo')

  // --- expansion map + overrides ---
  const expansions = await loadExpansions()
  const jp = await japaneseExpansionIds(expansions)
  if (jp.length === 0) failures.push('japaneseExpansionIds: expected some Japanese expansions')
  for (const id of jp) {
    if (expansions.get(id).language !== 'japanese') failures.push(`japaneseExpansionIds leaked ${id}`)
  }
  const unknownLeak = jp.filter((id) => expansions.get(id).language === 'unknown')
  eq(unknownLeak, [], 'japaneseExpansionIds never includes unknown')

  // overrides win, and may introduce brand-new ids (that is how OP14-OP17 will arrive)
  const tmp = path.join(PATHS.cacheDir, 'selftest')
  const baseFile = path.join(tmp, 'expansions.json')
  const ovFile = path.join(tmp, 'overrides.json')
  await writeJsonFile(baseFile, {
    expansions: [
      { expansionId: 5481, name: 'Awakening (Non-English)', language: 'japanese' },
      { expansionId: 5229, name: 'Romance Dawn', language: 'english_confirmed' },
      { expansionId: 6606, name: 'The Time of Battle (Asia Region Legal)', language: 'unknown' },
    ],
  })
  await writeJsonFile(ovFile, {
    overrides: {
      6606: { language: 'japanese', name: 'OP16 (JP)', why: 'human checked' },
      5481: { language: 'unknown', why: 'retracted' },
      9999: { language: 'japanese', name: 'OP17 (JP)', why: 'arrived later' },
    },
  })
  const merged = await loadExpansions({ expansionsPath: baseFile, overridesPath: ovFile })
  eq(merged.get(6606).language, 'japanese', 'override promotes unknown -> japanese')
  eq(merged.get(6606).name, 'OP16 (JP)', 'override renames')
  eq(merged.get(5481).language, 'unknown', 'override can demote')
  eq(merged.get(5481).name, 'Awakening (Non-English)', 'override without name keeps base name')
  eq(merged.get(9999).language, 'japanese', 'override adds an id the base file never had')
  eq(await japaneseExpansionIds(merged), [6606, 9999], 'japanese set follows overrides')

  // bad override language must throw, not silently fall back
  await writeJsonFile(ovFile, { overrides: { 6606: { language: 'jp' } } })
  let threw = false
  try {
    await loadExpansions({ expansionsPath: baseFile, overridesPath: ovFile })
  } catch (err) {
    threw = err instanceof ExpansionDataError
  }
  if (!threw) failures.push('loadExpansions: invalid override language must throw')

  await writeJsonFile(ovFile, { overrides: { 'OP16': { language: 'japanese' } } })
  threw = false
  try {
    await loadExpansions({ expansionsPath: baseFile, overridesPath: ovFile })
  } catch (err) {
    threw = err instanceof ExpansionDataError
  }
  if (!threw) failures.push('loadExpansions: non-numeric override key must throw')

  // --- log parsing ---
  eq(
    parseDeliveredCounts('2026-09-15T10:00:00.000Z INFO  5 of 397 matching cards delivered'),
    { delivered: 5, matching: 397 },
    'log: delivered counts',
  )
  eq(
    parseDeliveredCounts('1 of 10 matching cards delivered\n5 of 1,234 matching cards delivered'),
    { delivered: 5, matching: 1234 },
    'log: last line wins, thousands separator',
  )
  eq(parseDeliveredCounts('nothing here'), null, 'log: absent')

  // --- truncation ---
  eq(
    assessCompleteness({ rows: new Array(5), rowCap: 5, maxItems: 1000 }).truncated,
    true,
    'truncation: rows == cap is truncated',
  )
  eq(
    assessCompleteness({ rows: new Array(4), rowCap: 5, maxItems: 1000, delivered: { delivered: 4, matching: 4 } }).complete,
    true,
    'truncation: under cap with matching log is complete',
  )
  eq(
    assessCompleteness({ rows: new Array(4), rowCap: 5, delivered: { delivered: 4, matching: 400 } }).truncated,
    true,
    'truncation: log says more exist',
  )
  eq(assessCompleteness({ rows: [], rowCap: 5 }).truncated, true, 'truncation: no rows, no evidence')
  eq(
    assessCompleteness({ rows: new Array(9), rowCap: 5, maxItems: 1000, cappedResponses: 0 }).complete,
    true,
    'truncation: many responses, none capped -> complete (cap is per response)',
  )
  eq(
    assessCompleteness({ rows: new Array(9), rowCap: 5, maxItems: 1000, cappedResponses: 2 }).truncated,
    true,
    'truncation: any capped response -> truncated',
  )
  eq(
    assessCompleteness({ rows: new Array(2), rowCap: 5, budgetExhausted: true }).truncated,
    true,
    'truncation: budget exhausted',
  )
  eq(
    assessCompleteness({ rows: new Array(2), rowCap: 5, unresolvedPartitions: 1 }).truncated,
    true,
    'truncation: unresolved partition',
  )
  eq(
    assessCompleteness({ rows: new Array(2), rowCap: 5, runStatus: 'TIMED-OUT' }).truncated,
    true,
    'truncation: run not succeeded',
  )

  // --- row filtering: nothing non-Japanese survives ---
  const rows = [
    { productId: 1, name: 'Luffy (OP09-119)', expansionId: 5481, priceTrendEur: 12.5, currency: 'EUR' },
    { productId: 2, name: 'Luffy (OP09-119)', expansionId: 5229, priceTrendEur: 3.1, currency: 'EUR' },
    { productId: 3, name: 'Luffy (OP16-001)', expansionId: 6606, priceTrendEur: 80, currency: 'EUR' },
    { productId: 4, name: 'Luffy (OP09-120)', expansionId: 5481, priceTrendEur: 9, currency: 'USD' },
    { productId: 5, name: 'DON!! Card', expansionId: 5481, priceTrendEur: 0.2, currency: 'EUR' },
  ]
  const { kept, rejected } = partitionRows(rows, merged)
  eq(kept.map((r) => r.productId), [3], 'rows: only confirmed-Japanese expansions survive')
  eq(rejected.length, 4, 'rows: everything else rejected')
  if (!rejected.some((r) => r.reason.startsWith('non_eur_currency'))) {
    failures.push('rows: non-EUR currency must be rejected')
  }
  const hits = codeHitRate(kept)
  eq(hits.withCode, 1, 'hit rate counts codes')
  eq(priceGuideDateOf([{ priceGuideDate: '2026-09-14' }, { priceGuideDate: '2026-09-15' }]).priceGuideDate,
    '2026-09-15', 'priceGuideDate takes the newest')

  // --- offline degradation: a missing file must not crash ---
  const absent = await readCardmarketFile(path.join(tmp, 'definitely-missing.json'))
  eq(absent, null, 'readCardmarketFile: missing file -> null (downstream: not_pulled)')

  // --- pullExpansion against a fake transport (no network, no cost) ---
  let calls = 0
  const fakeFetch = async () => {
    calls += 1
    const body = JSON.stringify(
      new Array(5).fill(0).map((_, i) => ({
        productId: calls * 100 + i,
        name: `Card ${calls}-${i} (OP09-${String(100 + i).padStart(3, '0')})`,
        expansionId: 5481,
        priceTrendEur: 1 + i,
        currency: 'EUR',
        priceGuideDate: '2026-09-15',
      })),
    )
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const sentInputs = []
  const recordingFetch = async (url, init) => {
    sentInputs.push(JSON.parse(init.body))
    return fakeFetch()
  }
  const budget = new RunBudget(3)
  const pulled = await pullExpansion(5481, {
    token: 'fake',
    budget,
    rowCap: 5,
    maxItems: 1000,
    fetchImpl: recordingFetch,
  })
  eq(sentInputs[0].priceMinEur, undefined, 'pullExpansion: first band is unbounded')
  eq(sentInputs[0].priceMaxEur, undefined, 'pullExpansion: first band is unbounded')
  eq(sentInputs[0].sortBy, 'name', 'pullExpansion: deterministic ordering')
  if (sentInputs[1].priceMaxEur == null) failures.push('pullExpansion: lower child must be bounded above')
  // The hazard: capping the TOP band with a guessed ceiling would silently drop the most
  // expensive cards. The open-ended parent must stay open-ended.
  eq(sentInputs[2].priceMaxEur, undefined, 'pullExpansion: top band stays open-ended')
  if (sentInputs[2].priceMinEur == null) failures.push('pullExpansion: top band must be bounded below')
  eq(budget.used, 3, 'pullExpansion: stops at the run budget')
  eq(pulled.budgetExhausted, true, 'pullExpansion: reports budget exhaustion')
  if (pulled.rows.length !== 15) failures.push(`pullExpansion: expected 15 deduped rows, got ${pulled.rows.length}`)
  eq(
    assessCompleteness({ rows: pulled.rows, rowCap: 5, budgetExhausted: pulled.budgetExhausted }).truncated,
    true,
    'pullExpansion: capped+budget-exhausted result is truncated',
  )

  // --- a band the price filter cannot narrow must STOP, not bill a run per iteration ---
  // (this is what happens if the actor ignores priceMinEur/priceMaxEur, or if every card in
  // the band sits at the same price: the naive splitter recurses forever, spending money)
  const flatFetch = async () =>
    new Response(
      JSON.stringify(
        Array.from({ length: 5 }, (_, i) => ({
          productId: 2000 + i,
          name: `Flat ${i} (OP05-20${i})`,
          expansionId: 5481,
          priceTrendEur: 1,
          currency: 'EUR',
        })),
      ),
      { status: 200 },
    )
  const flatBudget = new RunBudget(40)
  const flat = await pullExpansion(5481, {
    token: 'fake',
    budget: flatBudget,
    rowCap: 5,
    maxItems: 1000,
    fetchImpl: flatFetch,
  })
  if (flatBudget.used >= 40) {
    failures.push(`pullExpansion: unsplittable band burned the whole budget (${flatBudget.used} runs)`)
  }
  eq(
    flat.unresolved.some((u) => u.reason === 'price_filter_ineffective'),
    true,
    'pullExpansion: detects a price filter that does not narrow',
  )
  eq(
    assessCompleteness({
      rows: flat.rows,
      rowCap: 5,
      cappedResponses: flat.cappedResponses,
      unresolvedPartitions: flat.unresolved.length,
    }).truncated,
    true,
    'pullExpansion: an unsplittable expansion is never reported complete',
  )

  // --- an Apify error object must throw, never be read as rows ---
  const errFetch = async () =>
    new Response(JSON.stringify({ error: { type: 'actor-memory-limit-exceeded' } }), { status: 200 })
  threw = false
  try {
    await runPriceGuide({ ...DEFAULT_INPUT }, { token: 'fake', fetchImpl: errFetch })
  } catch (err) {
    threw = err instanceof ApifyError
  }
  if (!threw) failures.push('runPriceGuide: error object must throw')

  // --- secrets never reach a log ---
  const red = redactSecrets('GET https://api.apify.com/v2/x?token=apify_api_SECRETVALUE1234 done', ['apify_api_SECRETVALUE1234'])
  if (red.includes('SECRETVALUE')) failures.push('redactSecrets leaked a token')

  // --- the published file always tells the truth about truncation ---
  const file = buildCardmarketFile({ rows: kept, truncated: true, reasons: ['row_cap_reached'], expansions: merged })
  eq(file.truncated, true, 'buildCardmarketFile: truncated flag')
  eq(file.usable, false, 'buildCardmarketFile: truncated is not usable')
  for (const key of ['generatedAt', 'priceGuideDate', 'truncated', 'rows']) {
    if (!(key in file)) failures.push(`buildCardmarketFile: missing contract key ${key}`)
  }

  // --- a COMPLETE pull is publishable, and ambiguity is preserved, never collapsed ---
  const jpTwo = [
    { productId: 10, name: 'Luffy (OP16-001)', expansionId: 6606, priceTrendEur: 4.5, priceLowEur: 3, avg7DayEur: 4.1, currency: 'EUR', priceGuideDate: '2026-09-15' },
    { productId: 11, name: 'Luffy (OP16-001)', expansionId: 6606, priceTrendEur: 180, priceLowEur: 150, avg7DayEur: 176, currency: 'EUR', priceGuideDate: '2026-09-15' },
    { productId: 12, name: 'Luffy (OP16-001)', expansionId: 5229, priceTrendEur: 2, currency: 'EUR', priceGuideDate: '2026-09-15' },
  ]
  const keptTwo = partitionRows(jpTwo, merged).kept
  const goodVerdict = assessCompleteness({
    rows: jpTwo, rowCap: 5, maxItems: 1000, delivered: { delivered: 3, matching: 3 }, runStatus: 'SUCCEEDED',
  })
  eq(goodVerdict.complete, true, 'a fully delivered under-cap run is complete')
  const goodFile = buildCardmarketFile({
    rows: keptTwo, truncated: goodVerdict.truncated, reasons: goodVerdict.reasons,
    expansions: merged, requestedExpansionIds: [6606, 9999],
  })
  eq(goodFile.truncated, false, 'complete pull -> truncated false')
  eq(goodFile.usable, true, 'complete pull -> usable')
  eq(goodFile.priceGuideDate, '2026-09-15', 'complete pull -> priceGuideDate')
  eq(isUsablePriceData(goodFile), true, 'isUsablePriceData: complete file')
  eq(isUsablePriceData({ ...goodFile, truncated: true }), false, 'isUsablePriceData: truncated file is unusable')
  eq(isUsablePriceData(null), false, 'isUsablePriceData: missing file is unusable')

  const index = buildCodeIndex(goodFile, merged)
  const candidates = index.get('OP16-001') ?? []
  // 4.50 EUR vs 180 EUR for one code. Collapsing these to one number is the failure mode
  // this whole app exists to prevent: both must survive.
  eq(candidates.length, 2, 'buildCodeIndex: BOTH Japanese printings kept (ambiguity preserved)')
  eq(candidates.map((c) => c.productId).sort(), [10, 11], 'buildCodeIndex: English printing excluded')
  eq(candidates[1].trendEur, 180, 'buildCodeIndex: trend mapped')
  eq(candidates[0].avg7Eur, 4.1, 'buildCodeIndex: avg7 mapped')
  eq(buildCodeIndex({ ...goodFile, truncated: true }, merged).size, 0, 'buildCodeIndex: truncated file yields nothing')

  if (failures.length) {
    warn(`\nSELF-TEST FAILED (${failures.length}):`)
    for (const f of failures) warn(`  - ${f}`)
    return 1
  }
  log(`self-test: all checks passed`)
  return 0
}

// ---------------------------------------------------------------------------
// dry run (no network, no cost)
// ---------------------------------------------------------------------------

async function dryRun(flags) {
  const expansions = await loadExpansions()
  const stats = languageStats(expansions)
  const jpIds = flags.expansions ?? (await japaneseExpansionIds(expansions))

  log('DRY RUN — no Apify call, no cost, nothing written.\n')
  log(`expansion map: ${expansions.size} expansions  (${JSON.stringify(stats)})`)
  const overridden = [...expansions.values()].filter((e) => e.source === 'override')
  log(`human overrides applied: ${overridden.length}`)
  for (const e of overridden) log(`  ${e.expansionId}  ${e.language.padEnd(18)} ${e.name}${e.why ? `  — ${e.why}` : ''}`)

  log(`\nwould price ${jpIds.length} confirmed-Japanese expansion(s).`)
  log(`would NOT price: ${stats.unknown} 'unknown' + ${stats.english_confirmed} 'english_confirmed'.`)
  log(`  'unknown' = no positive language evidence. Those cards fail closed to euStatus 'unmapped_set'`)
  log(`  rather than borrow an English or unverified printing's price. Resolve one by adding it to`)
  log(`  data/expansion-overrides.json; this script honours whatever that file says.`)
  const unresolvedArl = [...expansions.values()].filter(
    (e) => e.language === 'unknown' && /asia region legal/i.test(e.name),
  )
  if (unresolvedArl.length) {
    log(`  still unresolved, Asia-Region-Legal: ${unresolvedArl.map((e) => `${e.expansionId} ${e.name}`).join('; ')}`)
  }

  log(`\nplanned actor input (per expansion):`)
  log(
    JSON.stringify(
      { ...DEFAULT_INPUT, expansionIds: [jpIds[0] ?? 0], maxItems: flags.maxItems },
      null,
      2,
    ),
  )
  log(`\nrun budget if --live: ${flags.maxRuns} run(s); plan row cap assumed ${flags.rowCap}.`)

  const existing = await readCardmarketFile(flags.out)
  if (!existing) {
    log(`\n${path.relative(REPO_ROOT, flags.out)}: ABSENT -> build-index must set euStatus 'not_pulled' for every card.`)
  } else {
    log(
      `\n${path.relative(REPO_ROOT, flags.out)}: present, ${existing.rows.length} rows, ` +
        `truncated=${existing.truncated}, priceGuideDate=${existing.priceGuideDate}`,
    )
    if (existing.truncated) log(`  -> truncated file: consumers MUST treat it as 'not_pulled'.`)
  }
  return { mode: 'dry-run', runsUsed: 0, jpExpansions: jpIds.length, wrote: null }
}

// ---------------------------------------------------------------------------
// probe (one run: prove the client works and learn the TRUE result size)
// ---------------------------------------------------------------------------

async function probe(flags) {
  const token = apifyToken()
  const expansions = await loadExpansions()
  const jpIds = flags.expansions ?? (await japaneseExpansionIds(expansions))
  const target = jpIds[0]
  if (target == null && !flags.search) throw new Error('no confirmed-Japanese expansion to probe')

  const input = { ...DEFAULT_INPUT, maxItems: flags.maxItems }
  if (flags.expansions || !flags.search) input.expansionIds = [target]
  if (flags.search) input.searchQuery = flags.search
  log(`PROBE — one Apify run` +
    (input.expansionIds ? ` against expansion ${target} (${expansions.get(target)?.name ?? '?'})` : ` across ALL expansions`) +
    (flags.search ? ` searchQuery=${JSON.stringify(flags.search)}` : ''))
  log(`input: ${JSON.stringify(input)}`)

  const targetLang = target == null ? null : expansions.get(target)?.language
  if (target != null && targetLang !== 'japanese') {
    warn(
      `WARNING: expansion ${target} is language '${targetLang ?? 'unmapped'}', not 'japanese'. ` +
        `This is a diagnostic look only — its rows will be rejected and nothing is written to data/.`,
    )
  }

  const budget = new RunBudget(flags.maxRuns)
  budget.spend('probe')
  const started = Date.now()
  const { rows, paginationTotal } = await runPriceGuide(input, { token })
  log(`\nrun finished in ${((Date.now() - started) / 1000).toFixed(1)}s — ${rows.length} row(s) returned` +
    (paginationTotal == null ? '' : `, x-apify-pagination-total=${paginationTotal}`))

  if (rows[0]) {
    const keys = Object.keys(rows[0]).sort()
    log(`row fields: ${keys.join(', ')}`)
    log(`first row: ${JSON.stringify(rows[0], null, 2)}`)
  }

  // Run metadata + log are free API reads (no actor cost) and carry the true total.
  let runStatus = null
  let delivered = null
  let runId = null
  try {
    const meta = await fetchLastRunMeta({ token })
    runId = meta?.id ?? null
    runStatus = meta?.status ?? null
    log(`\nrun ${runId} status=${runStatus} datasetItems=${meta?.stats?.datasetItemCount ?? '?'}`)
    if (runId) {
      const logText = await fetchRunLog(runId, { token })
      delivered = parseDeliveredCounts(logText)
      const tail = logText.trim().split('\n').slice(-12).join('\n')
      log(`\nlog tail:\n${redactSecrets(tail, [token])}`)
    }
  } catch (err) {
    warn(`\ncould not read run metadata/log: ${redactSecrets(err.message, [token])}`)
  }

  const { kept, rejected } = partitionRows(rows, expansions)
  const hits = codeHitRate(
    rows.map((r) => ({ cardCode: extractCardCode(r?.name ?? '') })),
  )
  const verdict = assessCompleteness({
    rows,
    rowCap: flags.rowCap,
    maxItems: flags.maxItems,
    delivered,
    runStatus,
  })

  log(`\ncard-code extraction: ${hits.withCode}/${hits.total} (${hits.pct})`)
  if (hits.withoutCode > 0) {
    for (const r of rows) {
      if (!extractCardCode(r?.name ?? '')) log(`  no code: ${JSON.stringify(r?.name)}`)
    }
  }
  log(`rows kept after Japanese-only filter: ${kept.length}; rejected: ${rejected.length}`)
  for (const r of rejected.slice(0, 5)) log(`  rejected (${r.reason}): ${r.row?.name}`)

  log(`\nTRUNCATED: ${verdict.truncated}`)
  for (const reason of verdict.reasons) log(`  - ${reason}`)
  if (delivered) {
    log(`\nTRUE result size for this query: ${delivered.matching} card(s); this plan delivered ${delivered.delivered}.`)
  }
  log(`\nProbe writes nothing to data/. Use --live (on a paid plan) for a real pull.`)

  const dump = path.join(PATHS.cacheDir, `cardmarket-probe-${Date.now()}.json`)
  await writeJsonFile(dump, {
    probedAt: new Date().toISOString(),
    input,
    runId,
    runStatus,
    delivered,
    verdict,
    rows,
  })
  log(`raw probe response saved to ${dump} (gitignored)`)

  return {
    mode: 'probe',
    runsUsed: budget.used,
    rows: rows.length,
    truncated: verdict.truncated,
    delivered,
    codeHitRate: hits.pct,
    wrote: null,
  }
}

// ---------------------------------------------------------------------------
// live pull
// ---------------------------------------------------------------------------

async function livePull(flags) {
  const token = apifyToken()
  const expansions = await loadExpansions()
  const jpIds = flags.expansions ?? (await japaneseExpansionIds(expansions))
  if (jpIds.length === 0) throw new Error('no confirmed-Japanese expansions to pull')

  // Never request an expansion we have not positively confirmed as Japanese.
  const illegal = jpIds.filter((id) => expansions.get(id)?.language !== 'japanese')
  if (illegal.length) {
    throw new Error(
      `refusing to price non-Japanese expansion(s): ${illegal.join(', ')}. ` +
        `Confirm them in data/expansion-overrides.json first.`,
    )
  }

  log(`LIVE PULL — ${jpIds.length} Japanese expansion(s), run budget ${flags.maxRuns}, row cap ${flags.rowCap}`)

  const budget = new RunBudget(flags.maxRuns)
  const allRaw = new Map()
  const unresolved = []
  let budgetExhausted = false
  let cappedResponses = 0

  for (const id of jpIds) {
    if (budget.remaining === 0) {
      budgetExhausted = true
      unresolved.push({ expansionId: id, reason: 'budget_exhausted_before_start' })
      continue
    }
    const result = await pullExpansion(id, {
      token,
      budget,
      rowCap: flags.rowCap,
      maxItems: flags.maxItems,
      onRun: ({ expansionId, band, rows }) =>
        log(`  run ${budget.used}/${budget.maxRuns}  exp ${expansionId}  band ${band.min ?? '-'}..${band.max ?? '-'}  -> ${rows} rows`),
    })
    for (const row of result.rows) {
      const key = Number(row?.productId)
      allRaw.set(Number.isInteger(key) ? key : `anon:${allRaw.size}`, row)
    }
    unresolved.push(...result.unresolved)
    cappedResponses += result.cappedResponses
    if (result.budgetExhausted) budgetExhausted = true
  }

  const rawRows = [...allRaw.values()]
  const { kept, rejected } = partitionRows(rawRows, expansions)
  const verdict = assessCompleteness({
    rows: rawRows,
    rowCap: flags.rowCap,
    maxItems: flags.maxItems,
    budgetExhausted,
    unresolvedPartitions: unresolved.length,
    cappedResponses,
  })

  const hits = codeHitRate(kept)
  log(`\npulled ${rawRows.length} raw row(s); kept ${kept.length} after the Japanese-only filter; rejected ${rejected.length}`)
  log(`card-code extraction: ${hits.withCode}/${hits.total} (${hits.pct})`)
  log(`TRUNCATED: ${verdict.truncated}`)
  for (const reason of verdict.reasons) log(`  - ${reason}`)

  const payload = buildCardmarketFile({
    rows: kept,
    truncated: verdict.truncated,
    reasons: verdict.reasons,
    expansions,
    requestedExpansionIds: jpIds,
    rejected,
    runsUsed: budget.used,
  })

  if (verdict.truncated && !flags.allowTruncated) {
    const dump = path.join(PATHS.cacheDir, `cardmarket-truncated-${Date.now()}.json`)
    await writeJsonFile(dump, payload)
    warn(`\nREFUSING TO PUBLISH: this pull is not provably complete.`)
    warn(`Publishing it would let build-index infer "no Cardmarket row carries this code" from a`)
    warn(`partial set — i.e. ship wrong prices. ${path.basename(flags.out)} left untouched, so every`)
    warn(`card degrades to euStatus 'not_pulled'.`)
    warn(`Partial result saved for inspection: ${dump}`)
    warn(`Override with --allow-truncated (debug only; consumers must honour truncated:true).`)
    return { mode: 'live', runsUsed: budget.used, rows: kept.length, truncated: true, wrote: null, dump }
  }

  await writeJsonFile(flags.out, payload)
  log(`\nwrote ${flags.out} (${kept.length} rows, truncated=${payload.truncated})`)
  return { mode: 'live', runsUsed: budget.used, rows: kept.length, truncated: payload.truncated, wrote: flags.out }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  let flags
  try {
    flags = parseArgs(process.argv.slice(2))
  } catch (err) {
    warn(err.message)
    warn('run with --help for usage')
    process.exitCode = 64
    return
  }

  if (flags.help) {
    log(
      [
        'pull-cardmarket — European prices for confirmed-Japanese One Piece expansions',
        '',
        '  (default)            dry run: plan only, no network, no cost',
        '  --self-test          offline assertions',
        '  --probe              one Apify run: prove the client, read the true match count',
        '  --live               real pull; writes data/cardmarket.json when provably complete',
        '',
        '  --expansion <ids>    comma-separated expansion ids',
        '  --search <q>         actor searchQuery (probe only)',
        '  --max-items <n>      actor maxItems per run (default 1000)',
        '  --max-runs <n>       ceiling on Apify runs (default 1 probe / 40 live)',
        '  --row-cap <n>        plan row cap for truncation detection (default 5 = free plan)',
        '  --allow-truncated    publish a truncated file (debug only)',
        '  --out <path>         output file',
        '  --json               machine-readable summary',
      ].join('\n'),
    )
    return
  }

  loadDotEnv()

  try {
    let summary
    if (flags.selfTest) {
      process.exitCode = await selfTest()
      return
    } else if (flags.probe) {
      summary = await probe(flags)
    } else if (flags.live) {
      summary = await livePull(flags)
      if (summary.truncated && !summary.wrote) process.exitCode = 2
    } else {
      summary = await dryRun(flags)
    }
    if (flags.json) log(JSON.stringify(summary, null, 2))
  } catch (err) {
    const token = process.env.APIFY_TOKEN
    if (err instanceof BudgetExhaustedError) {
      warn(`stopped: ${err.message}`)
      process.exitCode = 2
      return
    }
    warn(`FAILED: ${redactSecrets(err?.message ?? String(err), token ? [token] : [])}`)
    if (err instanceof ApifyError && err.body) {
      warn(`apify said: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body).slice(0, 500)}`)
    }
    if (!(err instanceof ApifyError) && !(err instanceof ExpansionDataError) && err?.stack) {
      warn(redactSecrets(err.stack, token ? [token] : []))
    }
    process.exitCode = 1
  }
}

await main()
