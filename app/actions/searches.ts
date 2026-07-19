"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { enrichBatch } from "@/lib/enrichment/batch";
import { normaliseCompanyName } from "@/lib/enrichment/normalise-company";
import {
  DEFAULT_CRITERIA,
  type AIParsedCriteria,
  type SearchCriteria,
  type ShortlistState,
} from "@/lib/job-search/types";
import { runSearch } from "@/lib/job-search/pipeline";
import { geocodeUk } from "@/lib/geo";
import { htmlToText, tidyText } from "@/lib/job-search/html-to-text";
import { parseDescriptionServerSide, descriptionHash } from "@/lib/job-search/ai-parse";
import { suggestRelatedRolesServerSide } from "@/lib/job-search/ai-related-roles";
import { explainFitServerSide } from "@/lib/job-search/ai-fit";
import { getDefaultMasterProfile } from "@/app/actions/cv-tailoring";
import { ensureSearchEmbedding } from "@/lib/job-search/search-embedding";

// Attaches the AI read-back (ai_parsed) to the criteria on save. This is a paid
// server-side Sonnet call, so it is HASH-GUARDED: the editor's live "understand"
// action already stashes ai_parsed + ai_parsed_hash into the criteria it saves, so
// an unchanged description here is a no-op (no second call); only a description the
// user edited after (or never) analysing triggers a fresh parse.
//
// It deliberately does NOT merge anything into the explicit filters. The parse's
// suggestions (titles, avoid-list, seniority, working model, salary, location) are
// applied by the USER in the editor — silently forcing them here would re-impose a
// suggestion the user dismissed, and "never silently enforce" is the whole point.
// What ai_parsed drives downstream is honest: must_haves nudge ranking (and are
// shown on the card), deal_breakers only bite once the user confirms them into the
// Avoid list, and the summary is a trust read-back.
async function enrichCriteriaWithAI(
  description: string | undefined | null,
  criteria: SearchCriteria
): Promise<SearchCriteria> {
  const desc = description?.trim();
  if (!desc) return { ...criteria, ai_parsed: null, ai_parsed_hash: null };
  const hash = descriptionHash(desc);
  // Unchanged description → reuse the parse the editor already produced.
  if (criteria.ai_parsed && criteria.ai_parsed_hash === hash) return criteria;
  try {
    const parsed = await parseDescriptionServerSide(desc);
    // Record the hash only on success, so a transient failure re-parses next save
    // rather than being cached as "no parse" forever.
    if (!parsed) return { ...criteria, ai_parsed: null, ai_parsed_hash: null };
    return { ...criteria, ai_parsed: parsed, ai_parsed_hash: hash };
  } catch (e) {
    console.error("[enrichCriteriaWithAI] failed", e);
    return { ...criteria, ai_parsed: null, ai_parsed_hash: null };
  }
}

// Live "here's what we understood" for the editor. The editor calls this as the
// user finishes writing their description, shows the read-back + suggestions, and
// stashes { parsed, hash } into the criteria it later saves so the save path's
// hash guard skips a duplicate parse. Signed-in only; best-effort (null on any
// failure — the editor just shows nothing rather than an error).
export async function analyzeDescription(
  description: string
): Promise<{ parsed: AIParsedCriteria | null; hash: string | null }> {
  const { userId } = await auth();
  if (!userId) return { parsed: null, hash: null };
  const desc = (description ?? "").trim();
  if (desc.length < 8) return { parsed: null, hash: null };
  const parsed = await parseDescriptionServerSide(desc);
  return { parsed, hash: parsed ? descriptionHash(desc) : null };
}

// LLM fallback for "related roles" in the editor. Button-driven (never on a
// keystroke), so a paid call only happens when the user asks for it. The static
// taxonomy handles the common/typed cases for free; this covers niche titles it
// doesn't know. Returns [] on any failure — the editor just shows nothing extra.
export async function suggestRelatedRoles(input: {
  titles: string[];
  keywords?: string | null;
  description?: string | null;
}): Promise<{ roles: string[] }> {
  const { userId } = await auth();
  if (!userId) return { roles: [] };
  const titles = (input.titles ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 12);
  if (titles.length === 0) return { roles: [] };
  const roles = await suggestRelatedRolesServerSide({
    titles,
    keywords: input.keywords ?? null,
    description: input.description ?? null,
  });
  return { roles };
}

// Old shortlist rows were saved with jd_text that hadn't been HTML-decoded or
// paragraph-broken. Re-derive from jd_html at read-time so every existing row
// self-heals without a migration.
function jdLooksBad(text: string): boolean {
  if (!text) return true;
  if (/&#\d+;|&[a-z]+;/i.test(text)) return true;
  if (text.length > 400 && !text.includes("\n")) return true;
  return false;
}
function repairJd(jd_text: string | null | undefined, jd_html: string | null | undefined): string {
  const text = jd_text ?? "";
  if (jd_html && jdLooksBad(text)) return htmlToText(jd_html);
  return tidyText(text);
}

export interface Search {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  criteria: SearchCriteria;
  schedule_cron: string | null;
  jobs_per_run: number;
  active: boolean;
  auto_gen_summary: boolean;
  auto_gen_cv: boolean;
  auto_gen_cl: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShortlistPosting {
  id: string;
  company: string;
  title: string;
  location_raw: string | null;
  working_model: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_listed: boolean;
  jd_text: string;
  source: string;
  source_url: string | null;
  posted_at: string | null;
  // The three classified dimensions, shown on the card. A filter the user cannot
  // see the result of is a filter they cannot trust: if they tick "Contract" the
  // cards must SAY "Contract", or the filter is asking to be taken on faith.
  employment_type: string | null;
  seniority_hint: string | null;
  job_function: string | null;
  // Enrichment (may be null if enrichment hasn't run yet for this posting).
  enrichment: {
    size_bucket: string | null;
    size_confidence: string | null;
    ch_employee_count: number | null;
    ch_company_name: string | null;
    is_likely_recruiter: boolean | null;
  } | null;
}

export interface ShortlistEntry {
  id: string;
  state: ShortlistState;
  reject_reason: string | null;
  composite_rank: number | null;
  quality_score: number | null;
  match_to_user_score: number | null;
  match_to_search_score: number | null;
  ranking_explanation: Record<string, unknown> | null;
  jd_fit_summary: string | null;
  seen_at: string;
  decided_at: string | null;
  deleted_at: string | null;
  posting: ShortlistPosting | null;
}

export interface RunRecord {
  id: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  source_counts: Record<string, number> | null;
  dedupe_stats: Record<string, number> | null;
  filter_drops: Record<string, number> | null;
  shortlist_count: number | null;
  error: string | null;
}

export async function listSearches(): Promise<Search[]> {
  const { userId } = await auth();
  if (!userId) return [];
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("job_searches")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[listSearches]", error);
    return [];
  }
  return (data ?? []) as Search[];
}

export async function getSearch(id: string): Promise<Search | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("job_searches")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .single();
  if (error) {
    console.error("[getSearch]", error);
    return null;
  }
  return data as Search;
}

// A saved search only needs a name — everything else is optional. Filters
// alone (working model + salary + distance) produce a valid browse-mode
// pull. Description is optional and drives semantic ranking. Keywords and
// titles are optional and narrow the pull. Runtime behaviour is defined by
// pipeline's resolveSearchTerms.

export async function createSearch(input: {
  name: string;
  description?: string;
  criteria?: Partial<SearchCriteria>;
  jobs_per_run?: number;
  schedule_cron?: string | null;
}): Promise<{ id?: string; error?: string }> {
  const { userId } = await auth();
  if (!userId) return { error: "Unauthorised" };
  if (!input.name?.trim()) return { error: "Name is required" };

  const supabase = createServerSupabaseClient();
  const baseCriteria: SearchCriteria = {
    ...DEFAULT_CRITERIA,
    ...(input.criteria ?? {}),
    location: { ...DEFAULT_CRITERIA.location, ...(input.criteria?.location ?? {}) },
    working_model: { ...DEFAULT_CRITERIA.working_model, ...(input.criteria?.working_model ?? {}) },
    salary: { ...DEFAULT_CRITERIA.salary, ...(input.criteria?.salary ?? {}) },
  };
  const criteria = await enrichCriteriaWithAI(input.description, baseCriteria);

  // weights / ranking_weights are intentionally NOT written: they are inert DB
  // columns (defaults suffice) that no code reads — see the note in types.ts.
  const { data, error } = await supabase
    .from("job_searches")
    .insert({
      user_id: userId,
      name: input.name.trim(),
      description: input.description ?? null,
      criteria,
      jobs_per_run: input.jobs_per_run ?? 10,
      schedule_cron: input.schedule_cron ?? null,
    })
    .select("id")
    .single();
  if (error || !data) return { error: error?.message ?? "Create failed" };

  await supabase.from("job_search_sources").insert({
    search_id: data.id,
    source_type: "reed",
    enabled: true,
  });

  // Warm the query embedding in the background so it's ready before the first run.
  // Best-effort: a failure here just means the pipeline embeds it lazily instead.
  const newId = data.id as string;
  after(async () => {
    try {
      await ensureSearchEmbedding(createServerSupabaseClient(), {
        searchId: newId,
        criteria,
        description: input.description ?? null,
      });
    } catch (e) {
      console.error("[createSearch] embedding warm failed", e);
    }
  });

  revalidatePath("/roles");
  return { id: data.id };
}

export async function updateSearch(
  id: string,
  patch: Partial<Pick<Search, "name" | "description" | "jobs_per_run" | "schedule_cron" | "active" | "auto_gen_summary" | "auto_gen_cv" | "auto_gen_cl">> & {
    criteria?: SearchCriteria;
  }
): Promise<{ error?: string }> {
  const { userId } = await auth();
  if (!userId) return { error: "Unauthorised" };
  const supabase = createServerSupabaseClient();
  // Re-run the AI parse if description changed and criteria is being
  // updated. Keeps ai_parsed in sync with what the user actually wrote.
  const patchWithAI = { ...patch };
  if (patch.criteria && patch.description !== undefined) {
    const enriched = await enrichCriteriaWithAI(patch.description, patch.criteria);
    patchWithAI.criteria = enriched;
  }
  const { error } = await supabase
    .from("job_searches")
    .update({ ...patchWithAI, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) return { error: error.message };

  // Re-embed the query in the background if anything that feeds it may have changed.
  // The hash guard inside ensureSearchEmbedding makes this a no-op when the query
  // text is actually unchanged, so firing on any of these fields is cheap and safe.
  const queryTouched =
    patchWithAI.criteria !== undefined ||
    patch.description !== undefined ||
    patch.name !== undefined;
  if (queryTouched) {
    after(async () => {
      try {
        const bg = createServerSupabaseClient();
        const { data: s } = await bg
          .from("job_searches")
          .select("description, criteria")
          .eq("id", id)
          .single();
        if (!s) return;
        await ensureSearchEmbedding(bg, {
          searchId: id,
          criteria: s.criteria as SearchCriteria,
          description: (s.description as string | null) ?? null,
        });
      } catch (e) {
        console.error("[updateSearch] embedding refresh failed", e);
      }
    });
  }

  revalidatePath("/roles");
  return {};
}

export async function deleteSearch(id: string): Promise<{ error?: string }> {
  const { userId } = await auth();
  if (!userId) return { error: "Unauthorised" };
  const supabase = createServerSupabaseClient();
  const { error } = await supabase.from("job_searches").delete().eq("id", id).eq("user_id", userId);
  if (error) return { error: error.message };
  revalidatePath("/roles");
  return {};
}

/**
 * Validate a home postcode / place at EDIT time, using the exact resolver the
 * search pipeline uses (lib/geo → postcodes.io). This closes a silent-failure
 * gap: the pipeline calls resolveOrigin() on the saved postcode, and if it can't
 * be placed it turns distance filtering OFF for the whole run and only whispers
 * it in the run warnings. Catching a bad postcode as the user types means the run
 * never silently widens to the whole country.
 *
 * `place` is the resolved district/town name — shown back as confirmation
 * ("✓ Birmingham") so the user can see we understood them, not just that it parsed.
 * Accepts anything the pipeline accepts (full postcode, outcode, or a UK town),
 * because that is precisely what will resolve at run time.
 */
export async function validatePostcode(
  input: string
): Promise<{ valid: boolean; place: string | null }> {
  const { userId } = await auth();
  if (!userId) return { valid: false, place: null };
  const raw = (input ?? "").trim();
  if (!raw) return { valid: false, place: null };
  try {
    const hit = await geocodeUk(raw);
    return { valid: !!hit, place: hit?.name ?? null };
  } catch {
    // geocodeUk never throws by contract, but a transient DB-cache hiccup
    // shouldn't turn into a false "invalid postcode" — treat unknown as unproven,
    // not wrong. The user can still save; the run applies the same resolver.
    return { valid: false, place: null };
  }
}

export async function runSearchNow(id: string): Promise<{
  shortlisted?: number;
  pulled?: number;
  error?: string;
  searchTermsUsed?: string[];
  termsDerivedFrom?: "keywords" | "target_titles" | "description" | "browse";
}> {
  const { userId } = await auth();
  if (!userId) return { error: "Unauthorised" };
  const supabase = createServerSupabaseClient();
  const { data: s, error } = await supabase
    .from("job_searches")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .single();
  if (error || !s) return { error: "Search not found" };

  try {
    const result = await runSearch({
      userId,
      searchId: id,
      name: s.name,
      description: (s.description as string | null) ?? null,
      criteria: s.criteria as SearchCriteria,
      jobsPerRun: s.jobs_per_run,
      trigger: "manual",
    });
    revalidatePath("/roles");

    // Background enrichment sweep — runs after the response is sent so it
    // doesn't slow down the user. Enriches any postings the main pipeline
    // didn't reach (positions beyond the top-K enrich pool, or that ran out
    // of budget). This warms the cache so the NEXT run has more companies
    // pre-enriched and thus more survivors of the size filter.
    after(async () => {
      try {
        await postRunEnrichmentSweep();
      } catch (e) {
        console.error("[after runSearchNow] background enrichment sweep failed", e);
      }
    });

    return {
      shortlisted: result.shortlisted,
      pulled: result.pulled,
      error: result.error,
      searchTermsUsed: result.searchTermsUsed,
      termsDerivedFrom: result.termsDerivedFrom,
    };
  } catch (e) {
    console.error("[runSearchNow]", e);
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// Enriches un-enriched postings so subsequent searches have more cache.
// Runs post-response via next/server `after()` — so the user doesn't wait.
async function postRunEnrichmentSweep(): Promise<void> {
  const supabase = createServerSupabaseClient();
  const BUDGET_MS = 40_000;
  // Take up to 30 postings currently missing enrichment. Ordered newest-first
  // so recently-pulled jobs (higher chance of appearing in the next search)
  // get enriched preferentially.
  const { data: postings } = await supabase
    .from("job_postings")
    .select("id, company")
    .is("enrichment_id", null)
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(30);
  if (!postings || postings.length === 0) return;

  const rawNames = Array.from(new Set(postings.map((r) => (r.company as string) ?? "").filter(Boolean)));
  if (rawNames.length === 0) return;

  const { byNormalisedName } = await enrichBatch(rawNames, BUDGET_MS);

  // Update the postings we just enriched.
  for (const row of postings) {
    const norm = normaliseCompanyName((row.company as string) ?? "");
    if (!norm) continue;
    const enrichment = byNormalisedName.get(norm);
    if (!enrichment) continue;
    await supabase
      .from("job_postings")
      .update({ normalised_company_name: norm, enrichment_id: enrichment.id })
      .eq("id", row.id);
  }
  console.log(`[postRunEnrichmentSweep] enriched ${byNormalisedName.size}/${rawNames.length} companies`);
}

export async function listShortlist(
  searchId: string,
  opts?: { states?: ShortlistState[]; limit?: number }
): Promise<ShortlistEntry[]> {
  const { userId } = await auth();
  if (!userId) return [];
  const supabase = createServerSupabaseClient();
  const states = opts?.states ?? (["new", "interested"] as ShortlistState[]);
  const { data, error } = await supabase
    .from("job_shortlist")
    .select(
      `
      id, state, reject_reason, composite_rank, quality_score,
      match_to_user_score, match_to_search_score,
      ranking_explanation, jd_fit_summary, seen_at, decided_at, deleted_at,
      posting:job_postings (
        id, company, title, location_raw, working_model,
        salary_min, salary_max, salary_currency, salary_listed,
        jd_text, jd_html, source, source_url, posted_at,
        employment_type, seniority_hint, job_function,
        enrichment:company_enrichment (
          size_bucket, size_confidence, ch_employee_count,
          ch_company_name, is_likely_recruiter
        )
      )
    `
    )
    .eq("user_id", userId)
    .eq("search_id", searchId)
    .in("state", states)
    .order("composite_rank", { ascending: false, nullsFirst: false })
    .limit(opts?.limit ?? 200);
  if (error) {
    console.error("[listShortlist]", error);
    return [];
  }
  const rows = (data ?? []) as unknown as ShortlistEntry[];
  // Self-heal: re-derive JD text from jd_html for any row still holding
  // stale entity-encoded / paragraphless text. Also strip jd_html from the
  // returned payload to keep responses small.
  for (const r of rows) {
    if (r.posting) {
      const p = r.posting as ShortlistPosting & { jd_html?: string | null };
      r.posting.jd_text = repairJd(p.jd_text, p.jd_html);
      delete p.jd_html;
    }
  }
  return rows;
}

// Counts per shortlist state for one search, so the pane tabs can show how many
// jobs sit behind each ("New 12 · Interested 3 · …"). A tab with a number the
// user can't see is a tab they won't click. One round-trip pulling only the
// `state` column (a short enum string per row) and tallied in JS — cheaper than
// five head-count queries and the payload stays tiny.
export type ShortlistCounts = Record<
  "new" | "interested" | "applied" | "rejected_user" | "deleted",
  number
>;

export async function countShortlistByState(searchId: string): Promise<ShortlistCounts> {
  const empty: ShortlistCounts = { new: 0, interested: 0, applied: 0, rejected_user: 0, deleted: 0 };
  const { userId } = await auth();
  if (!userId) return empty;
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("job_shortlist")
    .select("state")
    .eq("user_id", userId)
    .eq("search_id", searchId);
  if (error) {
    console.error("[countShortlistByState]", error);
    return empty;
  }
  const counts: ShortlistCounts = { ...empty };
  for (const row of data ?? []) {
    const s = (row as { state: string }).state;
    if (s in counts) counts[s as keyof ShortlistCounts] += 1;
  }
  return counts;
}

export async function decideShortlist(
  id: string,
  state: Extract<ShortlistState, "interested" | "rejected_user" | "applied" | "deleted">,
  rejectReason?: string
): Promise<{ error?: string }> {
  const { userId } = await auth();
  if (!userId) return { error: "Unauthorised" };
  const supabase = createServerSupabaseClient();
  const patch: Record<string, unknown> = { state, decided_at: new Date().toISOString() };
  if (rejectReason) patch.reject_reason = rejectReason;
  if (state === "deleted") patch.deleted_at = new Date().toISOString();
  const { error } = await supabase
    .from("job_shortlist")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId);
  if (error) return { error: error.message };
  revalidatePath("/roles");
  return {};
}

export async function restoreShortlist(id: string): Promise<{ error?: string }> {
  const { userId } = await auth();
  if (!userId) return { error: "Unauthorised" };
  const supabase = createServerSupabaseClient();
  const { error } = await supabase
    .from("job_shortlist")
    .update({ state: "new", deleted_at: null, decided_at: null, reject_reason: null })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) return { error: error.message };
  revalidatePath("/roles");
  return {};
}

// On-demand "Why this fits" for a single shortlisted job. Generates a short, honest
// read (why you fit / your gap / your angle) from the user's master profile + the JD,
// persists it to jd_fit_summary, and returns it for immediate render. Signed-in only.
//
// Cost-guarded: a card that already has a summary returns the cached text WITHOUT
// spending a model call unless refresh=true. The "one request in flight per card"
// guard lives in the client (the button disables while a request is open). When the
// user has no master profile we still generate a JD-only read and flag hadProfile:false
// so the card can nudge them to build one for a personalised version.
export async function explainJobFit(
  shortlistId: string,
  opts?: { refresh?: boolean }
): Promise<{ summary?: string; hadProfile?: boolean; error?: string }> {
  const { userId } = await auth();
  if (!userId) return { error: "Unauthorised" };
  const supabase = createServerSupabaseClient();

  const { data, error } = await supabase
    .from("job_shortlist")
    .select(
      `id, jd_fit_summary,
       posting:job_postings ( title, company, jd_text, jd_html )`
    )
    .eq("id", shortlistId)
    .eq("user_id", userId)
    .single();
  if (error || !data) return { error: "Job not found" };

  // Supabase returns a to-one embed as an object here (same as listShortlist), but
  // guard for an array shape defensively.
  const rawPosting = (data as { posting: unknown }).posting;
  const posting = (Array.isArray(rawPosting) ? rawPosting[0] : rawPosting) as
    | { title: string | null; company: string | null; jd_text: string | null; jd_html: string | null }
    | null
    | undefined;
  if (!posting) return { error: "This job's details are missing." };

  // The user's profile drives both the prompt mode and the nudge. Best-effort:
  // a lookup failure just falls back to JD-only mode.
  const master = await getDefaultMasterProfile();
  const profile = master?.summary?.trim() || null;
  const hadProfile = !!profile;

  // Cache per card: reuse the stored summary unless an explicit refresh is asked.
  const cached = (data as { jd_fit_summary: string | null }).jd_fit_summary;
  if (cached && cached.trim() && !opts?.refresh) {
    return { summary: cached, hadProfile };
  }

  const jdText = repairJd(posting.jd_text, posting.jd_html);
  const result = await explainFitServerSide({
    profile,
    jdText,
    title: posting.title ?? "",
    company: posting.company ?? "",
  });
  if (!result) {
    return { error: "Couldn't generate this right now. Please try again." };
  }

  const { error: saveError } = await supabase
    .from("job_shortlist")
    .update({ jd_fit_summary: result.text })
    .eq("id", shortlistId)
    .eq("user_id", userId);
  if (saveError) {
    // Generation worked; only the save failed. Return the text so the user still
    // sees it this session rather than losing the spend to a transient DB blip.
    console.error("[explainJobFit] save failed", saveError);
  }

  return { summary: result.text, hadProfile: result.hadProfile };
}

export async function listRuns(searchId: string, limit = 10): Promise<RunRecord[]> {
  const { userId } = await auth();
  if (!userId) return [];
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("job_search_runs")
    .select("id, trigger, started_at, finished_at, source_counts, dedupe_stats, filter_drops, shortlist_count, error")
    .eq("user_id", userId)
    .eq("search_id", searchId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[listRuns]", error);
    return [];
  }
  return (data ?? []) as RunRecord[];
}
