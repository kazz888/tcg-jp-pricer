// scripts/lib/cardmarket.mjs
//
// Cardmarket (European price) adapter.
//
// GOVERNING RULE (outranks everything else in this file):
//   Never produce a EUR figure we are not certain of. One card code maps to MULTIPLE
//   Cardmarket printings (base / parallel / manga art) whose prices differ 10x-50x, and the
//   bulk price-guide rows carry NO rarity or variant field. So this adapter:
//     - prices ONLY expansions positively confirmed as language === 'japanese';
//     - never treats 'unknown' as Japanese, and never falls back to an English printing;
//     - never infers "the rest must be X" from a truncated result set;
//     - marks any result it cannot prove complete as truncated, i.e. unusable.
//
// Data source: Apify actor `lowlanddata~cardmarket-price-guide`, which reads Cardmarket's
// official daily price-guide files.
//
// FREE-PLAN REALITY: the account this was built against is on Apify's free plan, which
// hard-caps every run at 5 dataset rows. Five rows is never a full expansion, so every
// free-plan pull is TRUNCATED by definition. `assessCompleteness()` below detects that and
// the CLI refuses to publish it.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Repo root, resolved from this file's location (scripts/lib/ -> ../..). */
export const REPO_ROOT = path.resolve(HERE, '..', '..')

export const PATHS = Object.freeze({
  expansions: path.join(REPO_ROOT, 'data', 'expansions.json'),
  overrides: path.join(REPO_ROOT, 'data', 'expansion-overrides.json'),
  out: path.join(REPO_ROOT, 'data', 'cardmarket.json'),
  cacheDir: path.join(REPO_ROOT, '.cache'),
})

/** The only three language values the pipeline understands. */
export const LANGUAGES = Object.freeze(['japanese', 'english_confirmed', 'unknown'])

/** The only language that is ever priced. */
export const PRICED_LANGUAGE = 'japanese'

export const APIFY_ACTOR = 'lowlanddata~cardmarket-price-guide'
export const APIFY_BASE = 'https://api.apify.com/v2'

/** Apify free plan hard-caps every run's dataset at this many rows. */
export const FREE_PLAN_ROW_CAP = 5

/** Actor input default: only rows that actually carry a price. */
export const DEFAULT_INPUT = Object.freeze({
  game: 'onepiece',
  productType: 'cards',
  onlyPriced: true,
  // 'name' (not 'trend_desc') because it is the only stable order this actor offers, and
  // partitioned pulls need determinism to be reproducible.
  sortBy: 'name',
})

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ExpansionDataError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ExpansionDataError'
  }
}

export class ApifyError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message)
    this.name = 'ApifyError'
    this.status = status
    this.body = body
  }
}

export class BudgetExhaustedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BudgetExhaustedError'
  }
}

// ---------------------------------------------------------------------------
// Secrets hygiene
// ---------------------------------------------------------------------------

/**
 * Read APIFY_TOKEN without ever returning it to a log path.
 * Throws a message that contains no secret material.
 */
export function apifyToken(env = process.env) {
  const token = (env.APIFY_TOKEN || '').trim()
  if (!token) {
    throw new ApifyError(
      'APIFY_TOKEN is not set. Load it with:  set -a; . ./.env; set +a',
    )
  }
  return token
}

/**
 * Strip anything that looks like a token out of a string before logging it.
 * Covers `token=...` query params and bare `apify_api_...` tokens.
 */
export function redactSecrets(text, extraSecrets = []) {
  let out = String(text ?? '')
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('<redacted>')
  }
  out = out.replace(/([?&]token=)[^&\s"']+/gi, '$1<redacted>')
  out = out.replace(/\bapify_api_[A-Za-z0-9]+/g, '<redacted>')
  return out
}

// ---------------------------------------------------------------------------
// Expansion map: base file + human overrides
// ---------------------------------------------------------------------------

async function readJson(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true, value: null }
    throw err
  }
  try {
    return { missing: false, value: JSON.parse(raw) }
  } catch (err) {
    throw new ExpansionDataError(`${file} is not valid JSON: ${err.message}`)
  }
}

function assertLanguage(language, where) {
  if (!LANGUAGES.includes(language)) {
    throw new ExpansionDataError(
      `${where}: language must be one of ${LANGUAGES.join(' | ')}, got ${JSON.stringify(language)}`,
    )
  }
}

/**
 * Merge data/expansions.json with data/expansion-overrides.json. Overrides WIN, and may
 * introduce expansion ids the base snapshot never had (that is how OP14-OP17 will arrive).
 *
 * @returns {Promise<Map<number, {expansionId:number, name:string, language:string,
 *          source:'base'|'override', basis:string|null, why:string|null}>>}
 */
export async function loadExpansions({
  expansionsPath = PATHS.expansions,
  overridesPath = PATHS.overrides,
} = {}) {
  const base = await readJson(expansionsPath)
  if (base.missing) {
    throw new ExpansionDataError(`missing expansion map: ${expansionsPath}`)
  }
  if (!base.value || !Array.isArray(base.value.expansions)) {
    throw new ExpansionDataError(`${expansionsPath}: expected an { expansions: [...] } object`)
  }

  const map = new Map()
  for (const entry of base.value.expansions) {
    const id = Number(entry?.expansionId)
    if (!Number.isInteger(id) || id <= 0) {
      throw new ExpansionDataError(
        `${expansionsPath}: bad expansionId ${JSON.stringify(entry?.expansionId)}`,
      )
    }
    assertLanguage(entry?.language, `${expansionsPath} expansion ${id}`)
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new ExpansionDataError(`${expansionsPath}: expansion ${id} has no name`)
    }
    if (map.has(id)) {
      throw new ExpansionDataError(`${expansionsPath}: duplicate expansionId ${id}`)
    }
    map.set(id, {
      expansionId: id,
      name: entry.name.trim(),
      language: entry.language,
      source: 'base',
      basis: entry.basis ?? null,
      why: null,
    })
  }

  const ov = await readJson(overridesPath)
  if (!ov.missing) {
    if (ov.value == null || typeof ov.value !== 'object') {
      throw new ExpansionDataError(`${overridesPath}: expected an object`)
    }
    const overrides = ov.value.overrides
    if (overrides != null && (typeof overrides !== 'object' || Array.isArray(overrides))) {
      throw new ExpansionDataError(`${overridesPath}: "overrides" must be an object keyed by expansionId`)
    }
    for (const [key, value] of Object.entries(overrides ?? {})) {
      if (!/^\d+$/.test(key)) {
        throw new ExpansionDataError(
          `${overridesPath}: override key ${JSON.stringify(key)} is not an expansionId`,
        )
      }
      const id = Number(key)
      if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ExpansionDataError(`${overridesPath}: override ${id} must be an object`)
      }
      // This is the whole point of the file: an unvalidated typo here ("jp", "Japanese")
      // would silently fall back to "not Japanese" and quietly change what gets priced.
      assertLanguage(value.language, `${overridesPath} override ${id}`)
      const previous = map.get(id)
      const name =
        typeof value.name === 'string' && value.name.trim()
          ? value.name.trim()
          : (previous?.name ?? `Expansion ${id}`)
      map.set(id, {
        expansionId: id,
        name,
        language: value.language,
        source: 'override',
        basis: previous?.basis ?? null,
        why: typeof value.why === 'string' && value.why.trim() ? value.why.trim() : null,
      })
    }
  }

  return map
}

/**
 * Expansion ids that are positively confirmed Japanese. NEVER includes 'unknown' —
 * 'unknown' means "no positive evidence", and pricing against it is exactly the mistake
 * this app exists to avoid.
 *
 * @param {Map=} expansions optional pre-loaded map (avoids re-reading the files)
 * @returns {Promise<number[]>} ascending expansion ids
 */
export async function japaneseExpansionIds(expansions) {
  const map = expansions instanceof Map ? expansions : await loadExpansions()
  return [...map.values()]
    .filter((e) => e.language === PRICED_LANGUAGE)
    .map((e) => e.expansionId)
    .sort((a, b) => a - b)
}

/** Counts per language, for reporting. */
export function languageStats(expansions) {
  const stats = Object.fromEntries(LANGUAGES.map((l) => [l, 0]))
  for (const e of expansions.values()) stats[e.language] += 1
  return stats
}

// ---------------------------------------------------------------------------
// Card code extraction
// ---------------------------------------------------------------------------

// One Piece product codes as Cardmarket writes them:
//   booster/extra sets  OP01-001 .. OP17-xxx, EB01-001, PRB01-001
//   starter decks       ST01-001
//   promos              P-001
// The negative lookbehind keeps the bare `P` alternative from matching inside "OP09".
const CODE_RE = /(?<![A-Za-z0-9])(?:(OP|ST|EB|PRB)(\d{2})|(P))-(\d{3})(?![0-9A-Za-z])/gi

/**
 * Extract the canonical card code from a Cardmarket product name.
 *   "Monkey.D.Luffy (OP09-119)" -> "OP09-119"
 *   "Sanji (ST01-007)"          -> "ST01-007"
 *   "DON!! Card"                -> null
 *
 * Strict by design: if the name carries two different codes we return null rather than
 * guess which one is the product's own. A null here costs one card its EUR reference; a
 * wrong guess costs the user real cash at a counter.
 *
 * @param {string} name
 * @returns {string|null} upper-cased code, or null
 */
export function extractCardCode(name) {
  if (typeof name !== 'string' || !name) return null

  const all = []
  const parenthesised = []
  CODE_RE.lastIndex = 0
  let m
  while ((m = CODE_RE.exec(name)) !== null) {
    const code = (m[3] ? `P-${m[4]}` : `${m[1].toUpperCase()}${m[2]}-${m[4]}`).toUpperCase()
    all.push(code)
    const before = name.slice(0, m.index)
    const after = name.slice(m.index + m[0].length)
    const open = before.lastIndexOf('(')
    const close = before.lastIndexOf(')')
    if (open > close && after.includes(')')) parenthesised.push(code)
  }
  if (all.length === 0) return null

  const uniqueAll = [...new Set(all)]
  if (uniqueAll.length === 1) return uniqueAll[0]

  const uniqueParen = [...new Set(parenthesised)]
  if (uniqueParen.length === 1) return uniqueParen[0]
  return null
}

/** Set code a card code belongs to: "OP09-119" -> "OP09", "P-001" -> "P". */
export function setCodeOf(cardCode) {
  if (typeof cardCode !== 'string') return null
  const dash = cardCode.indexOf('-')
  return dash > 0 ? cardCode.slice(0, dash) : null
}

// ---------------------------------------------------------------------------
// Apify HTTP client
// ---------------------------------------------------------------------------

async function apifyFetch(url, { token, method = 'GET', body = null, timeoutMs = 300_000, fetchImpl = fetch }) {
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` }
  if (body != null) headers['Content-Type'] = 'application/json'

  const doFetch = (u, h) =>
    fetchImpl(u, {
      method,
      headers: h,
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })

  let res = await doFetch(url, headers)
  if (res.status === 401 || res.status === 403) {
    // Some Apify endpoints only accept the token as a query param. Retrying costs nothing:
    // an unauthenticated request never starts (and never bills) an actor run.
    const retryHeaders = { ...headers }
    delete retryHeaders.Authorization
    const u = new URL(url)
    u.searchParams.set('token', token)
    res = await doFetch(u.toString(), retryHeaders)
  }
  return res
}

/**
 * Run the price-guide actor synchronously and return its dataset rows.
 * One call == one Apify run == real money. Guard callers with a RunBudget.
 *
 * @returns {Promise<{rows:object[], status:number, paginationTotal:number|null}>}
 */
export async function runPriceGuide(input, { token, timeoutMs = 300_000, fetchImpl = fetch } = {}) {
  const tok = token ?? apifyToken()
  const url = `${APIFY_BASE}/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`
  const res = await apifyFetch(url, { token: tok, method: 'POST', body: input, timeoutMs, fetchImpl })

  const text = await res.text()
  if (!res.ok) {
    throw new ApifyError(`Apify run failed: HTTP ${res.status}`, {
      status: res.status,
      body: redactSecrets(text.slice(0, 2000), [tok]),
    })
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ApifyError('Apify returned a non-JSON body', {
      status: res.status,
      body: redactSecrets(text.slice(0, 500), [tok]),
    })
  }
  if (!Array.isArray(parsed)) {
    // Actor errors come back as an object, not the dataset array.
    throw new ApifyError(
      `Apify returned an error object instead of dataset rows: ${redactSecrets(
        JSON.stringify(parsed).slice(0, 500),
        [tok],
      )}`,
      { status: res.status, body: parsed },
    )
  }

  const totalHeader = res.headers.get('x-apify-pagination-total')
  return {
    rows: parsed,
    status: res.status,
    paginationTotal: totalHeader == null ? null : Number(totalHeader),
  }
}

/** GET /acts/<actor>/runs/last — metadata of the most recent run (free, no actor cost). */
export async function fetchLastRunMeta({ token, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const tok = token ?? apifyToken()
  const url = `${APIFY_BASE}/acts/${APIFY_ACTOR}/runs/last`
  const res = await apifyFetch(url, { token: tok, timeoutMs, fetchImpl })
  const text = await res.text()
  if (!res.ok) {
    throw new ApifyError(`could not read last run metadata: HTTP ${res.status}`, {
      status: res.status,
      body: redactSecrets(text.slice(0, 500), [tok]),
    })
  }
  const json = JSON.parse(text)
  return json.data ?? json
}

/** GET /logs/<runId> — the run log, as plain text (free, no actor cost). */
export async function fetchRunLog(runId, { token, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const tok = token ?? apifyToken()
  const res = await apifyFetch(`${APIFY_BASE}/logs/${encodeURIComponent(runId)}`, {
    token: tok,
    timeoutMs,
    fetchImpl,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new ApifyError(`could not read run log: HTTP ${res.status}`, {
      status: res.status,
      body: redactSecrets(text.slice(0, 500), [tok]),
    })
  }
  return text
}

/**
 * Pull the true match count out of the run log. The actor logs
 *   "5 of 397 matching cards delivered"
 * which is the ONLY way to learn the real size of a result set without paying for the rows.
 *
 * @returns {{delivered:number, matching:number}|null} the last such line in the log
 */
export function parseDeliveredCounts(logText) {
  if (typeof logText !== 'string' || !logText) return null
  const re = /(\d[\d,._\s]*)\s+of\s+(\d[\d,._\s]*)\s+matching\s+(?:cards|items|products|rows)\s+delivered/gi
  const toInt = (s) => Number(String(s).replace(/[,._\s]/g, ''))
  let last = null
  let m
  while ((m = re.exec(logText)) !== null) {
    const delivered = toInt(m[1])
    const matching = toInt(m[2])
    if (Number.isFinite(delivered) && Number.isFinite(matching)) last = { delivered, matching }
  }
  return last
}

// ---------------------------------------------------------------------------
// Truncation / completeness
// ---------------------------------------------------------------------------

/**
 * Decide whether a result set may be trusted as COMPLETE.
 *
 * Fails closed: completeness must be positively evidenced. "We saw no problem" is not
 * evidence — a capped run looks exactly like a small complete one unless you check.
 *
 * @returns {{complete:boolean, truncated:boolean, reasons:string[], evidence:object}}
 */
export function assessCompleteness({
  rows = [],
  rowCap = FREE_PLAN_ROW_CAP,
  maxItems = null,
  delivered = null,
  runStatus = null,
  budgetExhausted = false,
  unresolvedPartitions = 0,
  cappedResponses = null,
} = {}) {
  const n = Array.isArray(rows) ? rows.length : 0
  const reasons = []

  // The cap applies per RESPONSE, not to the aggregate of several partitioned responses.
  // Callers that made many requests pass cappedResponses; single-request callers pass
  // nothing and are judged on the one response they hold.
  if (cappedResponses == null) {
    if (rowCap != null && n >= rowCap) {
      reasons.push(`row_cap_reached: response returned ${n} rows, plan cap is ${rowCap}`)
    }
    if (maxItems != null && n >= maxItems) {
      reasons.push(`max_items_reached: response returned ${n} rows, maxItems was ${maxItems}`)
    }
  } else if (cappedResponses > 0) {
    reasons.push(
      `row_cap_reached: ${cappedResponses} response(s) came back at the ${rowCap}-row cap, so they hide rows`,
    )
  }
  if (delivered && delivered.delivered < delivered.matching) {
    reasons.push(
      `log_partial_delivery: actor delivered ${delivered.delivered} of ${delivered.matching} matching cards`,
    )
  }
  if (runStatus && runStatus !== 'SUCCEEDED') {
    reasons.push(`run_not_succeeded: status ${runStatus}`)
  }
  if (budgetExhausted) {
    reasons.push('run_budget_exhausted: stopped before the query space was covered')
  }
  if (unresolvedPartitions > 0) {
    reasons.push(
      `unresolved_partitions: ${unresolvedPartitions} partition(s) still capped after splitting as far as prices allow`,
    )
  }
  // No positive evidence of completeness at all (no log line) and nothing pulled: we simply
  // do not know. Treat as truncated.
  if (n === 0 && !delivered) {
    reasons.push('no_rows_and_no_delivery_evidence')
  }

  const complete = reasons.length === 0
  return {
    complete,
    truncated: !complete,
    reasons,
    evidence: { rows: n, rowCap, maxItems, delivered, runStatus, cappedResponses },
  }
}

// ---------------------------------------------------------------------------
// Run budget (an Apify run costs money; never let a loop spend without a ceiling)
// ---------------------------------------------------------------------------

export class RunBudget {
  constructor(maxRuns) {
    this.maxRuns = maxRuns
    this.used = 0
    this.exhausted = false
  }
  get remaining() {
    return Math.max(0, this.maxRuns - this.used)
  }
  spend(label = 'run') {
    if (this.used >= this.maxRuns) {
      this.exhausted = true
      throw new BudgetExhaustedError(`run budget exhausted (${this.maxRuns}) before ${label}`)
    }
    this.used += 1
    return this.used
  }
}

// ---------------------------------------------------------------------------
// Row normalisation
// ---------------------------------------------------------------------------

function num(value) {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/**
 * Normalise an actor row: keep every raw field, add the join key and the expansion's
 * verified language so downstream can never accidentally price a non-Japanese printing.
 */
export function normalizeRow(raw, expansions) {
  const expansionId = Number(raw?.expansionId)
  const known = Number.isInteger(expansionId) ? expansions?.get?.(expansionId) : null
  const name = typeof raw?.name === 'string' ? raw.name : ''
  return {
    ...raw,
    productId: Number(raw?.productId),
    name,
    cardCode: extractCardCode(name),
    expansionId: Number.isInteger(expansionId) ? expansionId : null,
    expansionName: known?.name ?? raw?.expansionName ?? null,
    expansionLanguage: known?.language ?? 'unknown',
    priceLowEur: num(raw?.priceLowEur),
    priceAvgEur: num(raw?.priceAvgEur),
    priceTrendEur: num(raw?.priceTrendEur),
    avg1DayEur: num(raw?.avg1DayEur),
    avg7DayEur: num(raw?.avg7DayEur),
    avg30DayEur: num(raw?.avg30DayEur),
  }
}

/**
 * Reject rows that cannot safely be priced. A dropped row degrades a card to 'no_match';
 * a kept bad row shows a wrong number. Dropping is always the safer error.
 */
export function partitionRows(rows, expansions) {
  const kept = []
  const rejected = []
  for (const raw of rows) {
    const row = normalizeRow(raw, expansions)
    if (!Number.isInteger(row.productId)) {
      rejected.push({ row, reason: 'no_product_id' })
      continue
    }
    if (row.expansionId == null) {
      rejected.push({ row, reason: 'no_expansion_id' })
      continue
    }
    if (row.currency != null && String(row.currency).toUpperCase() !== 'EUR') {
      rejected.push({ row, reason: `non_eur_currency:${row.currency}` })
      continue
    }
    if (row.expansionLanguage !== PRICED_LANGUAGE) {
      // Requested Japanese, got something else back: never silently keep it.
      rejected.push({ row, reason: `expansion_not_japanese:${row.expansionLanguage}` })
      continue
    }
    kept.push(row)
  }
  return { kept, rejected }
}

/** Fraction of kept rows whose name yielded a card code. */
export function codeHitRate(rows) {
  const total = rows.length
  const withCode = rows.filter((r) => r.cardCode).length
  return {
    total,
    withCode,
    withoutCode: total - withCode,
    rate: total === 0 ? null : withCode / total,
    pct: total === 0 ? 'n/a' : `${((withCode / total) * 100).toFixed(1)}%`,
  }
}

/** Most recent price-guide date across rows (they should all agree; if not, say so). */
export function priceGuideDateOf(rows) {
  const dates = [...new Set(rows.map((r) => r.priceGuideDate).filter(Boolean).map(String))].sort()
  return { priceGuideDate: dates.length ? dates[dates.length - 1] : null, allDates: dates }
}

// ---------------------------------------------------------------------------
// Partitioned pulling (the actor has no offset/cursor — you page by narrowing the query)
// ---------------------------------------------------------------------------

/**
 * Pull one expansion completely, by recursively bisecting the price range whenever a
 * response comes back at the row cap. Bands are inclusive on both ends, so a split can
 * duplicate a row but can never drop one; duplicates are removed by productId.
 *
 * On a plan whose cap is 5 this will hit the budget almost immediately — that is the
 * correct, honest outcome, and the caller marks the result truncated.
 */
export async function pullExpansion(
  expansionId,
  {
    token,
    budget,
    rowCap = FREE_PLAN_ROW_CAP,
    maxItems = 1000,
    minBandWidth = 0.01,
    maxDepth = 14,
    extraInput = {},
    fetchImpl = fetch,
    onRun = () => {},
  } = {},
) {
  const byProductId = new Map()
  const unresolved = []
  let budgetExhausted = false
  let cappedResponses = 0
  const queue = [{ min: null, max: null, depth: 0, parentIds: null }]
  const bandOf = (b) => ({ min: b.min, max: b.max, depth: b.depth })

  while (queue.length > 0) {
    const band = queue.shift()
    const input = {
      ...DEFAULT_INPUT,
      ...extraInput,
      expansionIds: [expansionId],
      maxItems,
    }
    if (band.min != null) input.priceMinEur = Number(band.min.toFixed(2))
    if (band.max != null) input.priceMaxEur = Number(band.max.toFixed(2))

    try {
      budget.spend(`expansion ${expansionId} band ${band.min ?? '-'}..${band.max ?? '-'}`)
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        budgetExhausted = true
        unresolved.push({ expansionId, band: bandOf(band), reason: 'budget_exhausted' })
        break
      }
      throw err
    }

    const { rows } = await runPriceGuide(input, { token, fetchImpl })
    onRun({ expansionId, band: bandOf(band), rows: rows.length })

    const ids = new Set()
    for (const row of rows) {
      const id = Number(row?.productId)
      if (Number.isInteger(id)) {
        byProductId.set(id, row)
        ids.add(id)
      } else {
        byProductId.set(`anon:${byProductId.size}`, row)
      }
    }

    const capped = rows.length >= Math.min(rowCap ?? Infinity, maxItems ?? Infinity)
    if (!capped) continue
    cappedResponses += 1

    // Progress check. If narrowing the price band returned exactly the parent's rows, the
    // actor is not honouring priceMinEur/priceMaxEur — splitting further would just resubmit
    // the same query forever and bill a run each time. Stop and say so.
    if (
      band.parentIds &&
      ids.size > 0 &&
      ids.size === band.parentIds.size &&
      [...ids].every((id) => band.parentIds.has(id))
    ) {
      unresolved.push({ expansionId, band: bandOf(band), reason: 'price_filter_ineffective' })
      break
    }

    if (band.depth >= maxDepth) {
      unresolved.push({ expansionId, band: bandOf(band), reason: 'max_split_depth' })
      continue
    }

    // Capped: this band hides rows. Split it.
    const prices = rows
      .map((r) => num(r?.priceTrendEur) ?? num(r?.priceAvgEur) ?? num(r?.priceLowEur))
      .filter((p) => p != null)
    const lo = band.min ?? 0
    const hi = band.max ?? (prices.length ? Math.max(...prices) * 4 + 1 : 10_000)
    const mid = Number(((lo + hi) / 2).toFixed(2))
    // `mid` must land strictly inside the band. At cent resolution a narrow band rounds mid
    // onto an endpoint, which would re-enqueue the band unchanged: an unbounded loop that
    // bills an Apify run per iteration.
    if (hi - lo <= minBandWidth || !(mid > lo && mid < hi)) {
      // Every row here shares one price and the actor offers no other axis to split on.
      unresolved.push({ expansionId, band: bandOf(band), reason: 'price_band_not_splittable' })
      continue
    }
    // The upper child stays OPEN-ENDED whenever its parent was. `hi` is only an estimate of
    // where prices stop, and capping the top band with an estimate would silently drop every
    // card priced above it — i.e. exactly the expensive cards a mispriced counter offer hurts
    // most. A split point may be wrong; a missing ceiling can never hide a row.
    queue.push(
      { min: lo, max: mid, depth: band.depth + 1, parentIds: ids },
      { min: mid, max: band.max, depth: band.depth + 1, parentIds: ids },
    )
  }

  return {
    rows: [...byProductId.values()],
    unresolved,
    budgetExhausted,
    cappedResponses,
  }
}

// ---------------------------------------------------------------------------
// Output file
// ---------------------------------------------------------------------------

/**
 * Build the data/cardmarket.json payload.
 * Required keys — generatedAt, priceGuideDate, truncated, rows — are the contract with
 * scripts/build-index.mjs. Everything else is additive diagnostics.
 */
export function buildCardmarketFile({
  rows = [],
  truncated = true,
  reasons = [],
  expansions = new Map(),
  requestedExpansionIds = [],
  rejected = [],
  runsUsed = 0,
  delivered = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const { priceGuideDate, allDates } = priceGuideDateOf(rows)
  const hits = codeHitRate(rows)
  const setCodes = [...new Set(rows.map((r) => setCodeOf(r.cardCode)).filter(Boolean))].sort()
  const byExpansion = {}
  for (const row of rows) {
    const key = String(row.expansionId)
    byExpansion[key] = (byExpansion[key] ?? 0) + 1
  }

  return {
    generatedAt,
    priceGuideDate,
    truncated: Boolean(truncated),
    rows,

    // --- diagnostics (additive; build-index only needs the four keys above) ---
    schema: 1,
    game: 'one-piece',
    source: `apify:${APIFY_ACTOR}`,
    usable: !truncated,
    truncationReasons: reasons,
    note: truncated
      ? 'TRUNCATED — NOT a complete price guide. Consumers MUST treat every card as euStatus "not_pulled". Inferring anything by elimination from this file would ship wrong prices.'
      : 'Complete pull of every confirmed-Japanese expansion.',
    stats: {
      rows: rows.length,
      rejected: rejected.length,
      runsUsed,
      cardCodeHitRate: hits.pct,
      cardCodesFound: hits.withCode,
      namesWithoutCode: hits.withoutCode,
      distinctSetCodes: setCodes,
      rowsPerExpansion: byExpansion,
      priceGuideDates: allDates,
      deliveredPerLog: delivered,
    },
    requestedExpansionIds,
    expansionsPriced: requestedExpansionIds.map((id) => ({
      expansionId: id,
      name: expansions.get(id)?.name ?? null,
      language: expansions.get(id)?.language ?? null,
    })),
    rejectedSamples: rejected.slice(0, 20).map((r) => ({
      reason: r.reason,
      productId: r.row?.productId ?? null,
      name: r.row?.name ?? null,
      expansionId: r.row?.expansionId ?? null,
    })),
  }
}

export async function writeJsonFile(file, payload) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return file
}

// ---------------------------------------------------------------------------
// Downstream helpers (offline-safe reads for scripts/build-index.mjs)
// ---------------------------------------------------------------------------

/**
 * Read data/cardmarket.json without crashing when it does not exist.
 * A missing file is the normal state until a paid Apify plan exists.
 *
 * @returns {Promise<object|null>} null when absent (caller -> euStatus 'not_pulled')
 */
export async function readCardmarketFile(file = PATHS.out) {
  const { missing, value } = await readJson(file)
  if (missing) return null
  if (value == null || !Array.isArray(value.rows)) {
    throw new ExpansionDataError(`${file}: expected { generatedAt, priceGuideDate, truncated, rows }`)
  }
  return value
}

/**
 * True only when the file exists AND is a proven-complete pull. A truncated file must be
 * treated exactly like a missing one: euStatus 'not_pulled'.
 */
export function isUsablePriceData(file) {
  return Boolean(file) && Array.isArray(file.rows) && file.rows.length > 0 && file.truncated !== true
}

/**
 * Optional helper for build-index: Map<cardCode, EuCandidate[]>, restricted to
 * confirmed-Japanese expansions. Every candidate for a code is kept — picking one is
 * exactly what this app must never do.
 */
export function buildCodeIndex(file, expansions) {
  const index = new Map()
  if (!isUsablePriceData(file)) return index
  for (const row of file.rows) {
    const code = row.cardCode ?? extractCardCode(row.name)
    if (!code) continue
    const exp = expansions?.get?.(Number(row.expansionId))
    if (!exp || exp.language !== PRICED_LANGUAGE) continue
    const candidate = {
      productId: Number(row.productId),
      expansionId: Number(row.expansionId),
      expansionName: exp.name,
      name: row.name,
      trendEur: num(row.priceTrendEur),
      lowEur: num(row.priceLowEur),
      avg7Eur: num(row.avg7DayEur),
    }
    const list = index.get(code)
    if (list) list.push(candidate)
    else index.set(code, [candidate])
  }
  return index
}
