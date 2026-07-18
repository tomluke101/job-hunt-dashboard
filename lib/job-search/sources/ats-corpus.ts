// ATS supply at search time — served from the LOCAL corpus, not the network.
//
// The background worker (lib/ats/ingest.ts) has already pulled every registered
// employer's board into job_postings, geocoded and canonically keyed. So a search
// doesn't poll 2,000 boards; it runs one indexed SQL query. Zero API budget, zero
// latency, and it scales with the registry instead of collapsing under it.
//
// This is what "ATS-direct is the DEFAULT supply, not a bolt-on" means in practice.

import { createServerSupabaseClient } from "@/lib/supabase-server";
import { ATS_SOURCES, type PullInput, type RawJob, type SourceType } from "../types";
import { buildTargets, roleNouns, titleRelevantAny } from "../title-match";
import { atsColumnsAvailable } from "../schema-guard";
import { haversineMiles, type GeoPoint } from "@/lib/geo";

export interface CorpusPullResult {
  jobs: RawJob[];
  /** Per-ATS-provider counts. A provider silently sitting at 0 must be visible. */
  bySource: Record<string, number>;
  error?: string;
}

export interface CorpusPullInput extends PullInput {
  /** The user's resolved origin. Null for a nationwide / relocate search. */
  origin: GeoPoint | null;
  targetTitles: string[];
  acceptRemote: boolean;
}

/**
 * How stale a corpus row may be before we stop showing it.
 *
 * `last_seen_at` is the honest freshness signal, not `posted_at`: the ingest
 * worker refreshes last_seen_at every time it finds the job still on the board,
 * so a job that has DISAPPEARED from the employer's board stops being refreshed
 * and ages out. That's how a filled role leaves the corpus without us needing a
 * delete signal the ATS never sends.
 */
const MAX_STALE_DAYS = 14;

/** Degrees of latitude per mile. Longitude degrees shrink with cos(latitude). */
const MILES_PER_DEG_LAT = 69.0;

export async function pullFromCorpus(input: CorpusPullInput): Promise<CorpusPullResult> {
  const supabase = createServerSupabaseClient();
  const bySource: Record<string, number> = {};
  for (const s of ATS_SOURCES) bySource[s] = 0;

  // The corpus columns don't exist until supabase-ats-schema.sql is applied. Say so
  // out loud rather than returning a bare 0, which is indistinguishable from "no
  // ATS jobs matched your search".
  if (!(await atsColumnsAvailable(supabase))) {
    return {
      jobs: [],
      bySource,
      error: "ATS migration not applied to this database — no ATS supply. Run supabase-ats-schema.sql.",
    };
  }

  try {
    let q = supabase
      .from("job_postings")
      .select(
        "id, source, source_id, source_url, company, title, location_raw, jd_text, jd_html, " +
          "posted_at, expires_at, salary_min, salary_max, salary_currency, " +
          "department, employment_type, seniority_hint, job_function, " +
          "is_remote, country_code, place_name, lat, lng"
      )
      .in("source", ATS_SOURCES as unknown as string[])
      .gte("last_seen_at", new Date(Date.now() - MAX_STALE_DAYS * 86_400_000).toISOString());

    // --- title prefilter (trigram-indexed) --------------------------------
    // Narrow in SQL on the role noun before pulling rows into JS. The full
    // role-noun-plus-qualifier rule still runs below — this is only a cheap net.
    const targets = buildTargets(input.targetTitles);
    const nouns = roleNouns(targets);
    if (nouns.length) {
      q = q.or(nouns.map((n) => `title.ilike.%${n}%`).join(","));
    }

    // --- geography --------------------------------------------------------
    // A bounding box, not a radius: it's a plain index range scan. The exact
    // haversine runs on the survivors in JS, so the box only has to be a superset.
    if (input.origin && input.radiusMiles) {
      const dLat = input.radiusMiles / MILES_PER_DEG_LAT;
      const cos = Math.max(0.1, Math.cos((input.origin.lat * Math.PI) / 180));
      const dLng = input.radiusMiles / (MILES_PER_DEG_LAT * cos);

      const latLo = input.origin.lat - dLat;
      const latHi = input.origin.lat + dLat;
      const lngLo = input.origin.lng - dLng;
      const lngHi = input.origin.lng + dLng;

      // Remote roles have no coordinates but are legitimately "near" everyone —
      // they must be OR'd in, not excluded by the box.
      const box =
        `and(lat.gte.${latLo},lat.lte.${latHi},lng.gte.${lngLo},lng.lte.${lngHi})`;
      q = input.acceptRemote ? q.or(`${box},is_remote.is.true`) : q.or(box);
    }

    // --- salary floor -----------------------------------------------------
    // Keep rows with NO salary: most ATS postings state pay in the JD body, and a
    // null here means "unknown", never "£0". Excluding them would delete the bulk
    // of first-party supply the moment a user sets any floor at all.
    if (input.minSalary) {
      q = q.or(`salary_max.is.null,salary_max.gte.${input.minSalary}`);
    }

    const { data, error } = await q.limit(600);
    if (error) return { jobs: [], bySource, error: `corpus query: ${error.message}` };

    // Chaining .or() collapses supabase-js's row inference to GenericStringError.
    // The shape is fully determined by the .select() above, so assert it once here
    // rather than scattering casts across every field access below.
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;

    const jobs: RawJob[] = [];
    for (const r of rows) {
      // Full title rule (the SQL prefilter is deliberately loose).
      if (targets.length && !titleRelevantAny(r.title as string, targets)) continue;

      // Exact distance. The bounding box is a square around a circle, so its
      // corners are up to 41% further out than the radius the user asked for.
      if (input.origin && input.radiusMiles && r.lat != null && r.lng != null) {
        const d = haversineMiles(input.origin, { lat: r.lat as number, lng: r.lng as number });
        if (d > input.radiusMiles) continue;
      }

      const source = r.source as SourceType;
      bySource[source] = (bySource[source] ?? 0) + 1;

      jobs.push({
        source,
        // Corpus rows carry their job_postings.id so the ranker can fetch their
        // semantic similarity by id. Network jobs never have this.
        posting_id: r.id as string,
        source_id: r.source_id as string,
        source_url: (r.source_url as string) ?? null,
        company: (r.company as string) ?? "",
        title: (r.title as string) ?? "",
        location_raw: (r.location_raw as string) ?? null,
        jd_text: (r.jd_text as string) ?? "",
        jd_html: (r.jd_html as string) ?? null,
        posted_at: (r.posted_at as string) ?? null,
        expires_at: (r.expires_at as string) ?? null,
        salary_min: (r.salary_min as number) ?? null,
        salary_max: (r.salary_max as number) ?? null,
        salary_currency: (r.salary_currency as string) ?? "GBP",
        department: (r.department as string) ?? null,
        employment_type: (r.employment_type as string) ?? null,
        seniority_hint: (r.seniority_hint as string) ?? null,
        job_function: (r.job_function as string) ?? null,
        is_remote: (r.is_remote as boolean) ?? null,
        country_hint: (r.country_code as string) ?? null,
        lat: (r.lat as number) ?? null,
        lng: (r.lng as number) ?? null,
        // Already resolved at ingest — hand the place name back so the pipeline's
        // geo pass is a no-op for corpus rows instead of re-geocoding thousands.
        location_candidates: r.place_name ? [r.place_name as string] : undefined,
      });
    }

    return { jobs, bySource };
  } catch (e) {
    return { jobs: [], bySource, error: `corpus: ${String(e)}` };
  }
}
