// Enrichment service — cache-or-fetch entrypoint used by the pipeline
// and the backfill action.
//
//   enrichCompany(rawName) → EnrichmentRow
//
// Steps:
//   1. Normalise the raw name → lookup key.
//   2. Return the cached row if fresh (<90 days). Append the raw name variant.
//   3. If the normalised name is a known unmatchable placeholder, upsert an
//      'unmatched' row so we don't re-query CH for the same placeholder.
//   4. Otherwise: CH search → pickBestMatch → matched | ambiguous | unmatched.
//      Matched → fetch profile + officers → derive size + recruiter flag.
//   5. Upsert result to `company_enrichment`.
//
// All CH errors are captured into the row as `enrichment_status='error'` +
// message; the pipeline never crashes on enrichment failure. Next run retries.

import { createServerSupabaseClient } from "@/lib/supabase-server";
import type { EnrichmentRow, EnrichmentStatus, CHCompanyProfile, CHOfficersSummary, CHSearchCandidate } from "./types";
import { normaliseCompanyName, isUnmatchableName } from "./normalise-company";
import {
  searchCompanies,
  getCompanyProfile,
  getCompanyOfficersSummary,
  CHNotFoundError,
} from "./companies-house";
import { pickBestMatch, rankCandidatesByName } from "./match-scorer";
import { deriveSize, ageInYears, accountsSizeRank } from "./size-heuristic";
import { detectRecruiter } from "./recruiter-detect";
import { getLatestEmployeeCount, type EmployeeCountResult } from "./employee-count";
import { lookupSizeBandViaLlm, bandDistance } from "./size-llm";
import type { SizeBucket, SizeConfidence } from "./types";

const STALE_AFTER_DAYS = 90;

type SupabaseLike = ReturnType<typeof createServerSupabaseClient>;

function isStale(row: Pick<EnrichmentRow, "last_refreshed_at">): boolean {
  if (!row.last_refreshed_at) return true;
  const ageMs = Date.now() - new Date(row.last_refreshed_at).getTime();
  return ageMs > STALE_AFTER_DAYS * 86400_000;
}

async function selectByNormalisedName(
  supabase: SupabaseLike,
  normalised: string
): Promise<EnrichmentRow | null> {
  const { data, error } = await supabase
    .from("company_enrichment")
    .select("*")
    .eq("normalised_name", normalised)
    .maybeSingle();
  if (error) {
    console.error("[enrichment] cache read failed", error);
    return null;
  }
  return (data as EnrichmentRow | null) ?? null;
}

async function appendRawNameVariant(
  supabase: SupabaseLike,
  row: EnrichmentRow,
  rawName: string
): Promise<void> {
  const trimmed = rawName.trim();
  if (!trimmed) return;
  if (row.raw_names.includes(trimmed)) return;
  // Cap the audit trail at 20 variants so pathological inputs don't bloat.
  const next = [...row.raw_names, trimmed].slice(-20);
  await supabase
    .from("company_enrichment")
    .update({ raw_names: next })
    .eq("id", row.id);
}

interface UpsertInput {
  normalised: string;
  rawName: string;
  status: EnrichmentStatus;
  error?: string | null;
  profile?: CHCompanyProfile | null;
  officers?: CHOfficersSummary | null;
  candidates?: CHSearchCandidate[] | null;
  employeeCount?: EmployeeCountResult | null;
  employeeCountSource?: string | null;      // 'xbrl' when a real filed figure was parsed, else null
  employeeCountReasoning?: string | null;   // the source filing URL
  size?: ResolvedSize | null;               // see resolveSize()
}

export interface ResolvedSize {
  bucket: SizeBucket;
  confidence: SizeConfidence;
  source: string | null;      // 'xbrl' | 'llm-band' | 'llm-band-override' | null
  reasoning: string | null;
}

const SIZE_UNKNOWN: ResolvedSize = {
  bucket: "unknown",
  confidence: "low",
  source: null,
  reasoning: null,
};

/**
 * Decide a company's size band from the two sources we have.
 *
 * The two sources answer different questions and fail in different ways:
 *
 *   XBRL employee count — a real, citable figure parsed from a Companies House
 *     filing. Precise, but only as trustworthy as the ENTITY MATCH behind it.
 *     When CH matching picks the wrong company (it matched "Amazon Flex" to a
 *     2-employee shell), the count is real but describes a business the
 *     jobseeker has never heard of. Only ~22% of companies have one at all,
 *     because large private UK firms file paper accounts.
 *
 *   Brand-level LLM band — asks what size the EMPLOYER BRAND is, which is the
 *     thing the user is actually filtering on. Wide coverage, and it declines
 *     rather than guess when it doesn't recognise the name.
 *
 * Precedence: a filed count wins, because it's ground truth — UNLESS the
 * brand-level answer disagrees with it by two or more bands. That disagreement
 * is strong evidence the CH match is the wrong entity, so we take the brand and
 * mark the result `medium` rather than silently publish "Amazon Flex: startup".
 */
async function resolveSize(params: {
  rawName: string;
  profile?: CHCompanyProfile | null;
  employeeCount?: EmployeeCountResult | null;
}): Promise<ResolvedSize> {
  const { rawName, profile, employeeCount } = params;

  // Ground-truth path: a real filed headcount for an actively trading company.
  const countBucket: SizeBucket | null =
    employeeCount?.count != null && (!profile || profile.company_status === "active")
      ? deriveSize({
          employeeCount: employeeCount.count,
          companyStatus: profile?.company_status ?? "active",
        }).bucket
      : null;

  // Brand path. Runs for every company — matched, ambiguous or unmatched —
  // because CH matching is exactly what fails for the biggest, most
  // recognisable employers (Specsavers, Co-op, Aberdeenshire Council).
  let llm = null as Awaited<ReturnType<typeof lookupSizeBandViaLlm>>;
  try {
    llm = await lookupSizeBandViaLlm({
      brandName: rawName,
      chLegalName: profile?.company_name ?? null,
      sicCodes: profile?.sic_codes ?? null,
    });
  } catch (e) {
    console.error(`[enrichment] size LLM failed for "${rawName}"`, e);
  }

  if (countBucket && countBucket !== "unknown") {
    const drift = bandDistance(countBucket, llm?.band ?? null);
    if (llm?.band && drift !== null && drift >= 2) {
      // Filed count and brand disagree wildly → the CH entity is almost
      // certainly not the employer posting this job.
      return {
        bucket: llm.band,
        confidence: "medium",
        source: "llm-band-override",
        reasoning:
          `filed count ${employeeCount?.count} implies ${countBucket}, but brand reads ${llm.band} ` +
          `(${drift} bands apart) — likely wrong Companies House entity. ${llm.reasoning}`.slice(0, 500),
      };
    }
    return {
      bucket: countBucket,
      confidence: "high",
      source: "xbrl",
      reasoning: employeeCount?.source_doc_url ?? null,
    };
  }

  if (llm?.band) {
    return {
      bucket: llm.band,
      confidence: "high",
      source: "llm-band",
      reasoning: llm.reasoning,
    };
  }

  // Nothing trustworthy. Stay unknown rather than guess.
  return {
    ...SIZE_UNKNOWN,
    reasoning: llm ? `llm-declined: ${llm.confidence} — ${llm.reasoning}`.slice(0, 500) : null,
  };
}

async function upsertEnrichment(
  supabase: SupabaseLike,
  inp: UpsertInput
): Promise<EnrichmentRow | null> {
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    normalised_name: inp.normalised,
    raw_names: [inp.rawName.trim()].filter(Boolean),
    enrichment_status: inp.status,
    enrichment_error: inp.error ?? null,
    last_refreshed_at: now,
  };

  if (inp.profile) {
    const p = inp.profile;
    payload.ch_company_number = p.company_number ?? null;
    payload.ch_company_name = p.company_name ?? null;
    payload.ch_company_status = p.company_status ?? null;
    payload.ch_company_type = p.type ?? null;
    payload.ch_date_of_creation = p.date_of_creation ?? null;
    payload.ch_sic_codes = p.sic_codes ?? [];
    payload.ch_accounts_next_due = p.accounts?.next_due ?? null;
    payload.ch_accounts_last_made_up_to = p.accounts?.last_accounts?.made_up_to ?? null;
    payload.ch_accounts_type = p.accounts?.last_accounts?.type ?? null;
    payload.ch_registered_address = p.registered_office_address ?? null;
  }
  if (inp.officers) {
    payload.ch_officers_active_count = inp.officers.active_count ?? null;
    payload.ch_officers_total_count = inp.officers.total_results ?? null;
  }
  if (inp.employeeCount) {
    payload.ch_employee_count = inp.employeeCount.count;
    payload.ch_employee_count_period_end = inp.employeeCount.period_end;
    payload.ch_employee_count_source_url = inp.employeeCount.source_doc_url;
    payload.ch_employee_count_status = inp.employeeCount.status;
  } else {
    payload.ch_employee_count = null;
    payload.ch_employee_count_period_end = null;
    payload.ch_employee_count_source_url = null;
    payload.ch_employee_count_status = null;
  }
  payload.ch_employee_count_source = inp.employeeCountSource ?? null;
  payload.ch_employee_count_reasoning = inp.employeeCountReasoning ?? null;

  // Size is resolved upstream by resolveSize(), which reconciles the filed
  // XBRL count against the brand-level LLM band. It runs for every row —
  // matched, ambiguous and unmatched alike — so this no longer depends on a
  // successful Companies House match.
  const size = inp.size ?? SIZE_UNKNOWN;
  payload.size_bucket = size.bucket;
  payload.size_confidence = size.confidence;
  payload.size_source = size.source;
  payload.size_reasoning = size.reasoning;

  // Recruiter detection runs for EVERY row, matched or not.
  //
  // It used to sit inside the matched-only branch above, which meant the ~45%
  // of companies that come back `ambiguous` or `unmatched` from Companies House
  // never had the flag written and silently kept the column default of false —
  // so Hays, four Michael Page divisions, Morgan Hunt and Elevation Recruitment
  // were all reaching the shortlist as "not a recruiter". CH matching is
  // irrelevant to the question: the company NAME is the primary signal, and the
  // SIC code is a bonus we only have when a match succeeded.
  const recruiterName = inp.profile?.company_name ?? inp.rawName;
  const rec = detectRecruiter(inp.profile?.sic_codes ?? [], recruiterName);
  payload.is_likely_recruiter = rec.is_recruiter;
  payload.recruiter_reason = rec.reason;
  if (inp.candidates) {
    payload.candidates = inp.candidates;
  }

  // Read existing row to preserve first_enriched_at + increment refresh_count.
  const existing = await selectByNormalisedName(supabase, inp.normalised);
  if (existing) {
    payload.raw_names = existing.raw_names.includes(inp.rawName.trim())
      ? existing.raw_names
      : [...existing.raw_names, inp.rawName.trim()].filter(Boolean).slice(-20);
    payload.first_enriched_at = existing.first_enriched_at ?? now;
    payload.refresh_count = existing.refresh_count + 1;
    const { data, error } = await supabase
      .from("company_enrichment")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) {
      console.error("[enrichment] update failed", error, payload);
      return null;
    }
    return data as EnrichmentRow;
  } else {
    payload.first_enriched_at = now;
    payload.refresh_count = 1;
    const { data, error } = await supabase
      .from("company_enrichment")
      .insert(payload)
      .select("*")
      .single();
    if (error) {
      // Race: another concurrent call may have inserted the same normalised
      // name. Re-select and treat as a hit.
      const raced = await selectByNormalisedName(supabase, inp.normalised);
      if (raced) return raced;
      console.error("[enrichment] insert failed", error, payload);
      return null;
    }
    return data as EnrichmentRow;
  }
}

/**
 * Enrich a single raw company name — returns the persisted EnrichmentRow
 * (or null on database failure). Caches per normalised name; refreshes rows
 * older than STALE_AFTER_DAYS.
 */
export async function enrichCompany(rawName: string): Promise<EnrichmentRow | null> {
  const supabase = createServerSupabaseClient();
  const normalised = normaliseCompanyName(rawName);
  if (!normalised) {
    // Empty/unusable input — nothing to store.
    return null;
  }

  // Cache hit + fresh?
  const cached = await selectByNormalisedName(supabase, normalised);
  if (cached && !isStale(cached) && cached.enrichment_status !== "error") {
    await appendRawNameVariant(supabase, cached, rawName);
    return cached;
  }

  // Known unmatchable placeholder — persist an unmatched row so we don't retry.
  if (isUnmatchableName(normalised)) {
    return upsertEnrichment(supabase, {
      normalised,
      rawName,
      status: "unmatched",
      error: "known unmatchable pattern",
    });
  }

  // Query Companies House.
  try {
    const candidates = await searchCompanies(normalised);
    const outcome = pickBestMatch(normalised, candidates);

    // Companies House couldn't pin the company down. That says nothing about
    // how big the employer is — CH matching fails hardest on exactly the
    // household names (Specsavers, Co-op, a county council) whose size the
    // brand-level lookup knows perfectly well. So we still resolve a size.
    if (outcome.type === "unmatched") {
      return upsertEnrichment(supabase, {
        normalised,
        rawName,
        status: "unmatched",
        size: await resolveSize({ rawName }),
      });
    }
    if (outcome.type === "ambiguous") {
      return upsertEnrichment(supabase, {
        normalised,
        rawName,
        status: "ambiguous",
        candidates: outcome.candidates,
        size: await resolveSize({ rawName }),
      });
    }

    // Pick the best operating entity from the top-N name-matched candidates.
    //
    // CH's search returns dormant holding shells and small subsidiaries with
    // similar name-scores. Naïvely picking the first active+non-dormant
    // candidate yields wrong answers ("reed" → REED ACCOUNTS LIMITED, a small
    // accountancy sub, instead of REED SPECIALIST RECRUITMENT LIMITED which
    // is the actual big operating employer).
    //
    // Fix: fetch profiles for top-3 in parallel, then pick by:
    //   1. operating (active + non-dormant) beats non-operating
    //   2. larger statutory accounts category wins (group/full > medium > small > dormant)
    //   3. original name-score is the final tiebreak
    //
    // Cost: 5 profile+officer fetches in parallel (~5.5s at 550ms rate).
    // Pool of 5 is large enough for common brand names ("Reed", "GXO Logistics",
    // "Cedar") where the operating parent may not be in the top-3 by name score
    // alone but is definitely within the top-5.
    const MAX_TRIES = 5;
    const ranked = rankCandidatesByName(normalised, candidates).slice(0, MAX_TRIES);
    if (ranked.length === 0) {
      return upsertEnrichment(supabase, {
        normalised,
        rawName,
        status: "unmatched",
      });
    }

    // Fetch profile + officers for each candidate in parallel. Officers total
    // count is a strong "which is the real operating entity" tiebreak when
    // sister companies file the same accounts category (Reed Ltd vs Reed
    // Specialist Recruitment vs Reed Accounts — all `total-exemption-full`,
    // but the operating recruiter has hundreds of historical officers where
    // the small accountancy sub has 2 or 3).
    const withProfiles = await Promise.all(
      ranked.map(async (cand, nameRank) => {
        const [profile, officers] = await Promise.all([
          getCompanyProfile(cand.company_number).catch((e) => {
            if (e instanceof CHNotFoundError) return null;
            throw e;
          }),
          getCompanyOfficersSummary(cand.company_number).catch(() => null),
        ]);
        return { candidate: cand, profile, officers, nameRank };
      })
    );

    // Only keep candidates whose profile we successfully fetched.
    const usable = withProfiles.filter(
      (x): x is {
        candidate: CHSearchCandidate;
        profile: CHCompanyProfile;
        officers: CHOfficersSummary | null;
        nameRank: number;
      } => x.profile !== null
    );
    if (usable.length === 0) {
      return upsertEnrichment(supabase, {
        normalised,
        rawName,
        status: "unmatched",
        error: "no candidate profile fetch succeeded",
      });
    }

    // Rank by: operating status, then statutory accounts category, then
    // total historical officers (larger = more likely the operating parent),
    // then original name-match score.
    const scored = usable.map((x) => {
      const accountsType = x.profile.accounts?.last_accounts?.type ?? null;
      const isActive = x.profile.company_status === "active";
      const isDormant = accountsType === "dormant";
      const operatingRank = isActive && !isDormant ? 2 : isActive ? 1 : 0;
      return {
        ...x,
        operatingRank,
        sizeRank: accountsSizeRank(accountsType),
        officersTotal: x.officers?.total_results ?? 0,
      };
    });
    scored.sort((a, b) => {
      if (a.operatingRank !== b.operatingRank) return b.operatingRank - a.operatingRank;
      if (a.sizeRank !== b.sizeRank) return b.sizeRank - a.sizeRank;
      if (a.officersTotal !== b.officersTotal) return b.officersTotal - a.officersTotal;
      return a.nameRank - b.nameRank;
    });
    const winner = scored[0];
    const officers = winner.officers;

    // Low-confidence guard.
    //
    // Companies House's search doesn't return the actual big operating entity
    // for common brand names ("Reed" doesn't surface REED SPECIALIST RECRUITMENT
    // LIMITED; "GXO Logistics" hides GXO LOGISTICS UK LIMITED; etc.). When we
    // end up picking a TINY company from a pool of many similarly-named sister
    // companies, we're probably wrong — the real operating employer just isn't
    // indexed for our search query.
    //
    // Rule: if the pool has 4+ candidates AND the winner files small-company
    // accounts, don't confidently claim a match. Flag as ambiguous, store the
    // candidates, and let the debug UI show them for manual resolution. Better
    // to say "we don't know" than to show a startup label for Reed.
    const SMALL_ACCOUNTS_CATEGORIES = new Set([
      "small",
      "total-exemption-small",
      "total-exemption-full",
      "unaudited-abridged",
      "abridged",
      "micro-entity",
    ]);
    const winnerAcctType = (winner.profile.accounts?.last_accounts?.type ?? "").toLowerCase();
    const winnerIsSmall = SMALL_ACCOUNTS_CATEGORIES.has(winnerAcctType);
    if (usable.length >= 4 && winnerIsSmall) {
      const flaggedCandidates: CHSearchCandidate[] = usable.slice(0, 5).map((x) => ({
        company_number: x.candidate.company_number,
        title: x.candidate.title,
        company_status: x.candidate.company_status,
        company_type: x.candidate.company_type,
        date_of_creation: x.candidate.date_of_creation,
      }));
      return upsertEnrichment(supabase, {
        normalised,
        rawName,
        status: "ambiguous",
        candidates: flaggedCandidates,
        error: "common brand name — CH search likely missing the operating entity",
      });
    }

    // Fetch the real employee count from the winner's latest iXBRL accounts.
    // Skip the fetch entirely when the accounts category guarantees no useful
    // data (dormant companies don't file employees; micro-entities are exempt
    // from disclosing them). Saves ~2s of CH API calls per such company —
    // meaningful given how many small recruitment agencies file this way.
    // (winnerAcctType already computed above for the ambiguous-flag guard.)
    const SKIP_EMP_FETCH = new Set(["dormant", "micro-entity", "no-accounts-type-available", ""]);
    let employeeCount: EmployeeCountResult;
    if (SKIP_EMP_FETCH.has(winnerAcctType)) {
      employeeCount = {
        count: null,
        period_end: null,
        source_doc_url: null,
        status: winnerAcctType === "dormant"
          ? "skip-dormant"
          : winnerAcctType === "micro-entity"
          ? "skip-micro-entity"
          : "skip-no-accounts",
      };
    } else {
      employeeCount = await getLatestEmployeeCount(winner.candidate.company_number).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[enrichment] employee-count fetch failed for ${winner.candidate.company_number}`, e);
        return { count: null, period_end: null, source_doc_url: null, status: `error:${msg.slice(0, 100)}` };
      });
    }

    // The employee count is now only ever a real, filed XBRL figure — we no
    // longer ask an LLM to invent a headcount number. (That prompt asked for a
    // precise accounting disclosure about a legal entity and declined on 30 of
    // the 31 companies it saw.) Size is decided separately, by resolveSize().
    const employeeCountSource = employeeCount.count !== null ? "xbrl" : null;
    const employeeCountReasoning =
      employeeCount.count !== null ? employeeCount.source_doc_url : null;

    return upsertEnrichment(supabase, {
      normalised,
      rawName,
      status: "matched",
      profile: winner.profile,
      officers,
      employeeCount,
      employeeCountSource,
      employeeCountReasoning,
      size: await resolveSize({
        rawName,
        profile: winner.profile,
        employeeCount,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[enrichment] error for "${normalised}"`, msg);
    return upsertEnrichment(supabase, {
      normalised,
      rawName,
      status: "error",
      error: msg.slice(0, 500),
    });
  }
}
