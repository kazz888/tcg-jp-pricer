// Shared data contract. Pipeline scripts WRITE this; the UI READS it.
// Rule that governs the whole app: NEVER show a single EUR number we are not
// sure of. Ambiguity is surfaced, never collapsed.

/**
 * How strongly we believe a narrowed pairing. NOTHING here is a verification.
 *  'strong' - an expansion-determined pairing, or a rank pairing whose price
 *             ladders separate by >= 2.7x at every adjacent step.
 *  'weak'   - a rank pairing that cleared the 1.65x bar but no more, or one
 *             touching Cardmarket's sub-EUR 0.20 quantisation floor, or a
 *             pooled-promo pairing. Measured error around 7%.
 *  'none'   - reserved. We do not emit it: a refused pairing carries no match
 *             metadata at all, so the card renders exactly as it does today.
 */
export type EuMatchLikelihood = 'strong' | 'weak' | 'none'

/** exact > strong > moderate, in order of how much the evidence rests on price. */
export type EuMatchLevel = 'exact' | 'strong' | 'moderate'

/** 'expansion' = decided by set membership, price never consulted. */
export type EuMatchBasis = 'expansion' | 'rank'

/** A Cardmarket printing we believe corresponds to a card code. */
export interface EuCandidate {
  productId: number
  expansionId: number
  expansionName: string
  /** Cardmarket's product name, e.g. "Monkey.D.Luffy (OP09-119)" */
  name: string
  trendEur: number | null
  lowEur: number | null
  avg7Eur: number | null
  /**
   * Present on AT MOST ONE candidate per card, and only when the printing
   * matcher reached a conclusion. Its absence is not evidence against a
   * candidate - it is the normal state. `reason` is the short in-list marker
   * ("best guess"); the full hedged sentence lives on Card.euMatch.reason.
   */
  match?: EuCandidateMatch
}

export interface EuCandidateMatch {
  likelihood: EuMatchLikelihood
  /** Short marker for the expanded candidate list. */
  reason: string
  /** 1-based position on the price ladder within this candidate's block. */
  rank: number
}

/**
 * A best guess at WHICH Cardmarket printing a Yuyu-tei printing is.
 *
 * Read this before rendering it: a card carrying euMatch is STILL euStatus
 * 'ambiguous'. This is a likelihood, never a verification. It must be shown at
 * lower visual weight than an 'ok' price - body text, secondary colour, no
 * verdict band - always prefixed ("~EUR 12.40 if this is the printing"), always
 * accompanied by its `reason`, and always with every other candidate in
 * Card.eu one tap away.
 */
export interface EuMatch {
  /** The chosen EuCandidate.productId. Every other candidate is still in eu[]. */
  productId: number
  level: EuMatchLevel
  likelihood: EuMatchLikelihood
  basis: EuMatchBasis
  /** Cardmarket expansionId, or 'PROMO' for the pooled promo block. */
  block: number | 'PROMO'
  /** 1-based position on the price ladder, of `ofM` printings in the block. */
  rank: number
  ofM: number
  /**
   * Smallest adjacent log price gap across BOTH ladders. null for an
   * expansion-determined pairing, where price was never consulted.
   */
  separation: number | null
  /** exp(separation), i.e. the smallest adjacent step as a multiple. */
  stepX: number | null
  reasonCode: 'expansion_sole' | 'promo_sole' | 'rank_separated' | 'rank_close'
  /** Ready-to-render hedged sentence. Never says "verified" or "confirmed". */
  reason: string
}

/**
 * Why we did NOT narrow. Carries no guess of any kind - it exists only so the
 * UI can say something more useful than silence next to the full candidate list.
 */
export interface EuRefusal {
  reasonCode:
    | 'block_count_mismatch'
    | 'low_separation'
    | 'eur_floor'
    | 'eu_price_missing'
    | 'jp_price_missing'
    | 'no_candidate_in_block'
    | 'unmapped_bucket'
    | 'implausible_ratio'
  reason: string
  /** Yuyu-tei printings carrying this card code. */
  jpPrintings: number
  /** Cardmarket candidates carrying this card code. */
  euCandidates: number
}

export type EuStatus =
  | 'ok'            // >=1 candidate from a confirmed-Japanese expansion
  | 'ambiguous'     // multiple candidates, cannot disambiguate variant -> show ALL
  | 'unmapped_set'  // card's set has no verified Japanese expansion (e.g. OP17)
  | 'no_match'      // set is mapped, but no Cardmarket row carries this code
  | 'not_pulled'    // Cardmarket data not fetched yet (no Apify plan)

/** One Yuyu-tei SKU. Variant-level: several rows can share a `code`. */
export interface Card {
  /** Canonical join key, e.g. "OP09-119". "-" for DON!! cards (no code). */
  code: string
  /** Japanese name, may carry a variant suffix like "(パラレル)". */
  name: string
  /** Variant marker parsed out of the name, e.g. "パラレル". */
  variant: string | null
  /** Yuyu-tei rarity badge, e.g. "P-SEC". */
  rarity: string
  /** Yuyu-tei listing bucket. NOT the set - parse the set from `code`. */
  setBucket: string
  /** Unique only as (setBucket, cardId). */
  cardId: string
  img: string
  detailUrl: string

  jpySell: number
  /** Yuyu-tei buyback. null when they do not buy this card. */
  jpyBuy: number | null
  /** Previous buyback price, when it recently moved. */
  jpyBuyPrev: number | null
  inStock: boolean
  stock: number

  euStatus: EuStatus
  /**
   * Every plausible Japanese printing. We do NOT pick one.
   * euMatch below may SUGGEST one; this array is still complete and unreordered,
   * and the UI must keep all of it reachable.
   */
  eu: EuCandidate[]

  /**
   * Best guess at which entry of `eu` this printing is, or absent when we
   * refused to guess. Present ONLY on euStatus 'ambiguous' cards, and it does
   * NOT promote them: euStatus stays 'ambiguous' and euContext()/verdict.tsx
   * must keep treating the card as ambiguous and must not build a headline
   * from it. A narrowed guess is never rendered with the visual weight of an
   * 'ok' price.
   */
  euMatch?: EuMatch | null
  /** Convenience mirror of euMatch.productId. */
  euBestGuess?: number | null
  /** Present when we declined to narrow. Mutually exclusive with euMatch. */
  euRefusal?: EuRefusal | null
}

export interface Coverage {
  /** Set codes Yuyu-tei is actively selling. */
  yuyuteiSets: string[]
  /** Set codes we can price against Cardmarket. */
  mappedSets: string[]
  /** Yuyu-tei sets with NO verified Japanese expansion. Must be shown to the user. */
  missingSets: string[]
  cardsTotal: number
  cardsWithEu: number
  cardsAmbiguous: number
}

export interface Fx {
  /** JPY per 1 EUR. */
  jpyPerEur: number
  source: string
  date: string
}

/**
 * A sealed product kind that is actually priced. The build classifier also
 * recognises 'case', 'deck' and 'other', but those are only ever COUNTED and
 * reported - none of them reaches the index, so none of them belongs in the
 * type the UI switches on. Cases in particular are excluded deliberately: a
 * case costs roughly 12x a box, and the two differ by one word in the name.
 */
export type SealedKind = 'booster_box' | 'booster_pack'

/**
 * One sealed product, priced in EUR only.
 *
 * READ THIS BEFORE RENDERING ONE. Sealed is ASYMMETRIC with singles, BY DESIGN.
 * A Card has a Japanese anchor (Yuyu-tei) plus a European comparison, and its
 * verdict is built from both. A SealedItem has ONLY the European side, and that
 * is a deliberate product decision, not a gap waiting to be filled: no Japanese
 * sealed price source is reachable (Yuyu-tei sells no sealed product,
 * Hareruya2's unopened catalogue is Pokemon-only, Rakuten needs an
 * applicationId), and a Japanese booster box sells for roughly the same yen
 * everywhere, so an averaged Japanese figure would add little against a 3-6x
 * European gap.
 *
 * A Europe-relative verdict band IS therefore permitted and is the intended
 * design - but the European frame must live in the band's LOUDEST text, not
 * only in the small print beside it. "WELL UNDER EU" is honest; a bare "STEAL"
 * overclaims, because nothing here knows the Japanese market price.
 * The agreed thresholds, as a fraction of the European trend price, are
 * 0.35 / 0.55 / 0.75 / 1.0.
 *
 * jpyRef stays permanently null. Treat it as reserved, not pending.
 */
export interface SealedItem {
  productId: number
  /** Cardmarket's product name, e.g. "Emperors in the New World Booster Box (Non-English)". */
  name: string
  kind: SealedKind
  expansionId: number
  expansionName: string | null
  /**
   * Set code derived from the singles in the same expansion (modal cardCode
   * set). null where that derivation was not safe - notably the PRB "The Best"
   * reprint sets, whose singles carry their ORIGINAL set codes, so the modal
   * code there would be a fabrication. null means "we do not know", never "no set".
   */
  setCode: string | null
  trendEur: number | null
  lowEur: number | null
  avg7Eur: number | null
  productUrl: string | null
  /**
   * Japanese reference price in yen. ALWAYS null today - see the note above.
   * The field exists so a Japanese source (Rakuten) can be added later as a data
   * change rather than a contract change. Render null as "no Japanese reference",
   * NEVER as 0 and never as a comparison.
   */
  jpyRef: number | null
}

export interface PriceIndex {
  generatedAt: string
  game: 'one-piece'
  fx: Fx
  coverage: Coverage
  cards: Card[]
  /**
   * Booster boxes and booster packs from confirmed-Japanese expansions. Absent
   * or empty when data/sealed.json was not built - consumers must treat a
   * missing array exactly like an empty one and simply show no sealed screen.
   */
  sealed?: SealedItem[]
}
