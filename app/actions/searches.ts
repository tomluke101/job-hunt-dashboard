"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import {
  DEFAULT_CRITERIA,
  DEFAULT_RANKING_WEIGHTS,
  DEFAULT_WEIGHTS,
  type CriteriaWeights,
  type SearchCriteria,
  type ShortlistState,
} from "@/lib/job-search/types";
import { runSearch } from "@/lib/job-search/pipeline";
import { htmlToText, tidyText } from "@/lib/job-search/html-to-text";

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
  weights: CriteriaWeights;
  ranking_weights: Record<string, number>;
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
}

export interface ShortlistEntry {
  id: string;
  state: ShortlistState;
  reject_reason: string | null;
  composite_rank: number | null;
  quality_score: number | null;
  match_to_user_score: number | null;
  match_to_search_score: number | null;
  career_fit_score: number | null;
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

export async function createSearch(input: {
  name: string;
  description?: string;
  criteria?: Partial<SearchCriteria>;
  weights?: Partial<CriteriaWeights>;
  jobs_per_run?: number;
  schedule_cron?: string | null;
}): Promise<{ id?: string; error?: string }> {
  const { userId } = await auth();
  if (!userId) return { error: "Unauthorised" };
  if (!input.name?.trim()) return { error: "Name is required" };

  const supabase = createServerSupabaseClient();
  const criteria: SearchCriteria = {
    ...DEFAULT_CRITERIA,
    ...(input.criteria ?? {}),
    location: { ...DEFAULT_CRITERIA.location, ...(input.criteria?.location ?? {}) },
    working_model: { ...DEFAULT_CRITERIA.working_model, ...(input.criteria?.working_model ?? {}) },
    salary: { ...DEFAULT_CRITERIA.salary, ...(input.criteria?.salary ?? {}) },
  };
  const weights: CriteriaWeights = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };

  const { data, error } = await supabase
    .from("job_searches")
    .insert({
      user_id: userId,
      name: input.name.trim(),
      description: input.description ?? null,
      criteria,
      weights,
      ranking_weights: DEFAULT_RANKING_WEIGHTS,
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

  revalidatePath("/roles");
  return { id: data.id };
}

export async function updateSearch(
  id: string,
  patch: Partial<Pick<Search, "name" | "description" | "jobs_per_run" | "schedule_cron" | "active" | "auto_gen_summary" | "auto_gen_cv" | "auto_gen_cl">> & {
    criteria?: SearchCriteria;
    weights?: CriteriaWeights;
  }
): Promise<{ error?: string }> {
  const { userId } = await auth();
  if (!userId) return { error: "Unauthorised" };
  const supabase = createServerSupabaseClient();
  const { error } = await supabase
    .from("job_searches")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) return { error: error.message };
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

export async function runSearchNow(id: string): Promise<{ shortlisted?: number; pulled?: number; error?: string }> {
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
      criteria: s.criteria as SearchCriteria,
      jobsPerRun: s.jobs_per_run,
      trigger: "manual",
    });
    revalidatePath("/roles");
    return { shortlisted: result.shortlisted, pulled: result.pulled, error: result.error };
  } catch (e) {
    console.error("[runSearchNow]", e);
    return { error: e instanceof Error ? e.message : String(e) };
  }
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
      match_to_user_score, match_to_search_score, career_fit_score,
      ranking_explanation, jd_fit_summary, seen_at, decided_at, deleted_at,
      posting:job_postings (
        id, company, title, location_raw, working_model,
        salary_min, salary_max, salary_currency, salary_listed,
        jd_text, jd_html, source, source_url, posted_at
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
