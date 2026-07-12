// The company → ATS board registry. Persistence layer for lib/ats/discover.ts.

import { createServerSupabaseClient } from "@/lib/supabase-server";
import { normaliseCompanyName } from "@/lib/enrichment/normalise-company";
import type { AtsBoard, AtsProviderId } from "./types";
import type { DiscoveredBoard } from "./discover";

export interface RegistryBoard extends AtsBoard {
  id: string;
  companyName: string;
  normalisedName: string;
  status: "active" | "empty" | "dead" | "unverified";
  lastJobCount: number | null;
  consecutiveFailures: number;
}

function rowToBoard(r: Record<string, unknown>): RegistryBoard {
  return {
    id: r.id as string,
    provider: r.provider as AtsProviderId,
    token: r.board_token as string,
    workday:
      r.provider === "workday"
        ? {
            tenant: (r.workday_tenant as string) ?? (r.board_token as string),
            host: (r.workday_host as string) ?? "wd3.myworkdayjobs.com",
            site: (r.workday_site as string) ?? "Careers",
          }
        : undefined,
    companyName: r.company_name as string,
    normalisedName: r.normalised_name as string,
    status: (r.status as RegistryBoard["status"]) ?? "active",
    lastJobCount: (r.last_job_count as number) ?? null,
    consecutiveFailures: (r.consecutive_failures as number) ?? 0,
  };
}

export async function upsertBoard(d: DiscoveredBoard): Promise<string | null> {
  const supabase = createServerSupabaseClient();
  const normalised = normaliseCompanyName(d.companyName ?? "");

  const { data, error } = await supabase
    .from("company_ats")
    .upsert(
      {
        normalised_name: normalised,
        company_name: d.companyName ?? "",
        provider: d.provider,
        board_token: d.token,
        workday_tenant: d.workday?.tenant ?? null,
        workday_host: d.workday?.host ?? null,
        // The unique index is on coalesce(workday_site,''), so a null here and an
        // empty string there must not both be reachable — normalise to null.
        workday_site: d.workday?.site ?? null,
        board_company_name: d.board_company_name,
        discovered_via: d.discovered_via,
        // An unverified board is one whose token we GUESSED and which reports no
        // company name of its own. It stays out of the active pool until proven —
        // attaching the wrong employer's jobs to a company is worse than missing it.
        status: d.verified ? (d.job_count > 0 ? "active" : "empty") : "unverified",
        verified_at: d.verified ? new Date().toISOString() : null,
        last_job_count: d.job_count,
      },
      { onConflict: "provider,board_token,workday_site" }
    )
    .select("id")
    .single();

  if (error) {
    console.error("[registry] upsertBoard failed", error.message);
    return null;
  }
  return data?.id ?? null;
}

/** Boards worth polling. `unverified` and `dead` are excluded by design. */
export async function listPollableBoards(limit = 5000): Promise<RegistryBoard[]> {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("company_ats")
    .select("*")
    .in("status", ["active", "empty"])
    // Oldest-polled first, so a run that hits its budget still makes forward
    // progress across the whole registry instead of re-polling the same head.
    .order("last_polled_at", { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) {
    console.error("[registry] listPollableBoards failed", error.message);
    return [];
  }
  return (data ?? []).map(rowToBoard);
}

export async function markPolled(
  boardId: string,
  jobCount: number,
  ingested: number,
  error?: string | null
): Promise<void> {
  const supabase = createServerSupabaseClient();
  const { data: cur } = await supabase
    .from("company_ats")
    .select("total_jobs_ingested, consecutive_failures")
    .eq("id", boardId)
    .single();

  const failures = error ? ((cur?.consecutive_failures as number) ?? 0) + 1 : 0;

  await supabase
    .from("company_ats")
    .update({
      last_polled_at: new Date().toISOString(),
      last_job_count: jobCount,
      total_jobs_ingested: ((cur?.total_jobs_ingested as number) ?? 0) + ingested,
      consecutive_failures: failures,
      last_error: error ?? null,
      // A board with zero jobs is NOT broken — the employer simply isn't hiring
      // this week. Keep polling it. Only repeated hard FAILURES kill a board, and
      // 5 in a row means the board is genuinely gone (company moved ATS, renamed).
      status: failures >= 5 ? "dead" : jobCount > 0 ? "active" : "empty",
    })
    .eq("id", boardId);
}

// ---------------------------------------------------------------------------
// Discovery attempt cache
// ---------------------------------------------------------------------------

/** Companies we've already tried and should not re-probe yet. */
export async function loadDiscoveryBlocklist(): Promise<Set<string>> {
  const supabase = createServerSupabaseClient();
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from("company_ats_discovery")
    .select("normalised_name, found, retry_after");

  const blocked = new Set<string>();
  for (const r of data ?? []) {
    const name = r.normalised_name as string;
    if (r.found) {
      blocked.add(name);
      continue;
    }
    // A miss is only blocked until its retry window opens: a company that wasn't
    // on Greenhouse last month may have migrated onto it since.
    const retry = r.retry_after as string | null;
    if (!retry || retry > nowIso) blocked.add(name);
  }
  return blocked;
}

const RETRY_MISS_DAYS = 30;

export async function recordDiscoveryAttempt(
  companyName: string,
  found: boolean,
  providersTried: AtsProviderId[],
  notes: string
): Promise<void> {
  const supabase = createServerSupabaseClient();
  const normalised = normaliseCompanyName(companyName);
  if (!normalised) return;

  const retryAfter = found
    ? null
    : new Date(Date.now() + RETRY_MISS_DAYS * 86_400_000).toISOString();

  const { data: existing } = await supabase
    .from("company_ats_discovery")
    .select("attempts")
    .eq("normalised_name", normalised)
    .maybeSingle();

  await supabase.from("company_ats_discovery").upsert(
    {
      normalised_name: normalised,
      company_name: companyName,
      found,
      providers_tried: providersTried,
      attempts: ((existing?.attempts as number) ?? 0) + 1,
      last_attempt_at: new Date().toISOString(),
      retry_after: retryAfter,
      notes,
    },
    { onConflict: "normalised_name" }
  );
}
