// Geocoding the long tail: gazetteer miss -> postcodes.io -> cache (both ways).
//
// postcodes.io is free, keyless, UK-only and unmetered at our volume — the same
// service lib/job-search/postcode.ts already uses for Adzuna's postcode->town
// translation. This module RE-USES that file's regexes rather than re-deriving
// them (a second, subtly-different postcode regex is a bug waiting to happen).
//
// Three endpoints, all verified live 2026-07-12:
//   places     GET /places?q=solihull&limit=1   -> result[]  {name_1, latitude, longitude, county_unitary}
//   postcode   GET /postcodes/{pc}              -> result    {latitude, longitude, admin_district}
//   outcode    GET /outcodes/{outcode}          -> result    {latitude, longitude, admin_district: STRING[]}
//
// CACHING IS NOT AN OPTIMISATION HERE, IT IS THE DESIGN. An ingest run sees
// thousands of postings and the SAME few hundred distinct location strings. And
// we cache NEGATIVES too: without that, every run re-queries postcodes.io for
// the same few hundred permanently-unresolvable strings ("Gaithersburg",
// "Global", "TBD") forever.
//
// NOTHING IN HERE MAY THROW. A geocode failure must degrade to "unresolved", not
// kill an ingest of 3,000 jobs.

import { looksLikePostcode } from "@/lib/job-search/postcode";
import {
  lookupUkPlace,
  normalise,
  type GeoPoint,
  type ResolvedPlace,
} from "./gazetteer";

// Same shapes as lib/job-search/postcode.ts. Kept private; that module owns the
// exported `looksLikePostcode`, which we import rather than re-implement.
const FULL_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;

const FETCH_TIMEOUT_MS = 8_000;

/** null = looked up and definitively NOT resolvable (a cached negative). */
type CacheEntry = ResolvedPlace | null;

/** In-process cache. Survives a whole ingest run; lost on cold start. */
const MEM = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Supabase-backed cache (survives cold starts). Degrades to memory-only.
// ---------------------------------------------------------------------------

interface MinimalSupabase {
  from(table: string): {
    select(cols: string): {
      in(col: string, vals: string[]): Promise<{ data: unknown[] | null }>;
      eq(col: string, val: string): {
        maybeSingle(): Promise<{ data: unknown | null }>;
      };
    };
    upsert(rows: unknown[], opts?: unknown): Promise<{ error: unknown }>;
  };
}

let supabasePromise: Promise<MinimalSupabase | null> | null = null;

/**
 * The module must keep working inside a plain `npx tsx` script with no env —
 * createServerSupabaseClient() asserts its env vars with `!` and createClient()
 * throws on an undefined URL. So: check the env FIRST, import dynamically, and
 * swallow anything that goes wrong. A missing DB cache is a performance
 * regression, never an outage.
 */
async function getSupabase(): Promise<MinimalSupabase | null> {
  if (!supabasePromise) {
    supabasePromise = (async () => {
      if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return null;
      }
      try {
        const { createServerSupabaseClient } = await import("@/lib/supabase-server");
        return createServerSupabaseClient() as unknown as MinimalSupabase;
      } catch {
        return null;
      }
    })();
  }
  return supabasePromise;
}

interface GeoCacheRow {
  query: string;
  lat: number | null;
  lng: number | null;
  country: string | null;
  name: string | null;
  resolved: boolean;
  source: string | null;
}

function rowToEntry(row: GeoCacheRow): CacheEntry {
  if (!row.resolved || row.lat == null || row.lng == null) return null;
  return {
    name: row.name ?? row.query,
    country: (row.country ?? "GB").toUpperCase(),
    lat: row.lat,
    lng: row.lng,
    // Provenance is preserved as "cache" so callers can tell a cached hit from a
    // fresh one; the original source lives in the DB column.
    source: "cache",
  };
}

async function dbGet(key: string): Promise<CacheEntry | undefined> {
  const sb = await getSupabase();
  if (!sb) return undefined;
  try {
    const { data } = await sb
      .from("geo_cache")
      .select("query,lat,lng,country,name,resolved,source")
      .eq("query", key)
      .maybeSingle();
    if (!data) return undefined;
    return rowToEntry(data as GeoCacheRow);
  } catch {
    return undefined;
  }
}

async function dbGetMany(keys: string[]): Promise<Map<string, CacheEntry>> {
  const out = new Map<string, CacheEntry>();
  const sb = await getSupabase();
  if (!sb || keys.length === 0) return out;
  // .in() with thousands of values blows the URL length limit — chunk it.
  const CHUNK = 200;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    try {
      const { data } = await sb
        .from("geo_cache")
        .select("query,lat,lng,country,name,resolved,source")
        .in("query", chunk);
      for (const row of (data ?? []) as GeoCacheRow[]) out.set(row.query, rowToEntry(row));
    } catch {
      // Ignore — we'll just re-geocode this chunk.
    }
  }
  return out;
}

async function dbPut(entries: Array<{ key: string; entry: CacheEntry; source: string }>): Promise<void> {
  const sb = await getSupabase();
  if (!sb || entries.length === 0) return;
  const rows = entries.map(({ key, entry, source }) => ({
    query: key,
    lat: entry?.lat ?? null,
    lng: entry?.lng ?? null,
    country: entry?.country ?? null,
    name: entry?.name ?? null,
    resolved: entry !== null,
    source,
  }));
  try {
    await sb.from("geo_cache").upsert(rows, { onConflict: "query" });
  } catch {
    // Cache write failure is not an ingest failure.
  }
}

// ---------------------------------------------------------------------------
// postcodes.io
// ---------------------------------------------------------------------------

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null; // 404 = no such place/postcode. A normal answer.
      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null; // network down, DNS, timeout, malformed JSON — all "unresolved".
  }
}

/** postcodes.io /places?q= — free-text UK place search. */
async function placesLookup(query: string): Promise<ResolvedPlace | null> {
  const d = await fetchJson(
    `https://api.postcodes.io/places?q=${encodeURIComponent(query)}&limit=1`
  );
  const results = d?.result as Array<Record<string, unknown>> | undefined;
  const hit = Array.isArray(results) ? results[0] : undefined;
  if (!hit) return null;

  const name = typeof hit.name_1 === "string" ? hit.name_1 : null;
  const lat = typeof hit.latitude === "number" ? hit.latitude : null;
  const lng = typeof hit.longitude === "number" ? hit.longitude : null;
  if (!name || lat == null || lng == null) return null;

  // ⚠️ EXACT-NAME GUARD. /places is a PREFIX/fuzzy search: it will happily answer
  // a query for a foreign town with some unrelated UK hamlet that merely starts
  // with the same letters. Accepting a loose match here would quietly relocate a
  // Munich job to a field in Norfolk. Foreign strings are meant to fall through
  // this function unresolved, so we only accept a match on the full name.
  if (normalise(name) !== normalise(query)) return null;

  return { name, country: "GB", lat, lng, source: "postcodes.io" };
}

/** postcodes.io /postcodes/{pc} and /outcodes/{outcode}. */
async function postcodeLookup(pc: string): Promise<ResolvedPlace | null> {
  const trimmed = pc.trim();

  if (FULL_POSTCODE.test(trimmed)) {
    const d = await fetchJson(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(trimmed)}`
    );
    const r = d?.result as
      | { latitude?: number; longitude?: number; admin_district?: string }
      | undefined;
    if (r && typeof r.latitude === "number" && typeof r.longitude === "number") {
      return {
        name: r.admin_district ?? trimmed.toUpperCase(),
        country: "GB",
        lat: r.latitude,
        lng: r.longitude,
        source: "postcodes.io",
      };
    }
  }

  // Fall back to the outward half. Covers a mistyped/retired unit postcode
  // (lib/job-search/postcode.ts learned this the hard way: "B1 1AA" can 404,
  // but outcode "B1" still resolves to central Birmingham), and covers boards
  // that only publish an outcode.
  const outward = trimmed.split(/\s+/)[0];
  if (OUTCODE.test(outward)) {
    const d = await fetchJson(
      `https://api.postcodes.io/outcodes/${encodeURIComponent(outward)}`
    );
    const r = d?.result as
      | { latitude?: number; longitude?: number; admin_district?: string[] }
      | undefined;
    if (r && typeof r.latitude === "number" && typeof r.longitude === "number") {
      // NOTE: on THIS endpoint admin_district is an ARRAY — one outcode can
      // straddle several districts. The first is the primary.
      const district = Array.isArray(r.admin_district) ? r.admin_district[0] : undefined;
      return {
        name: district ?? outward.toUpperCase(),
        country: "GB",
        lat: r.latitude,
        lng: r.longitude,
        source: "postcodes.io",
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Resolve ONE free-text UK query (place name or postcode) to a point.
 * Order: memory cache -> gazetteer -> DB cache -> postcodes.io.
 * Never throws. Returns null when nothing resolves (and caches that null).
 */
export async function geocodeUk(query: string): Promise<ResolvedPlace | null> {
  const key = normalise(query);
  if (!key) return null;

  const mem = MEM.get(key);
  if (mem !== undefined) return mem;

  // Gazetteer first: free, offline, and authoritative for the names we curated.
  const gaz = lookupUkPlace(query);
  if (gaz) {
    MEM.set(key, gaz);
    return gaz;
  }

  const cached = await dbGet(key);
  if (cached !== undefined) {
    MEM.set(key, cached);
    return cached;
  }

  const hit = looksLikePostcode(query)
    ? await postcodeLookup(query)
    : await placesLookup(query);

  MEM.set(key, hit);
  // Cache the negative too — that's the whole point (see file header).
  void dbPut([{ key, entry: hit, source: hit ? "postcodes.io" : "postcodes.io:miss" }]);
  return hit;
}

/**
 * Is there a UK postcode within 2km of this point?
 *
 * THE PROBLEM THIS SOLVES: a UK bounding box is not the UK. Ireland sits
 * entirely inside the UK's lat/lng envelope, and a bbox CANNOT separate
 * Northern Ireland (UK) from the Republic 40km south. The first leak of this
 * shape (Primark Dublin, via SmartRecruiters) was closed with "an explicit
 * provider country code beats the bbox" — but the jsonld provider surfaced the
 * case that fix can't reach: coordinates with NO country code at all (Boots
 * writes "-" in addressCountry, and its Drogheda store's coords are inside the
 * bbox). The postcode network IS the UK, Northern Ireland included: Lisburn
 * answers BT27, Drogheda answers nothing. Verified live 2026-07-16.
 *
 * Cached both ways in geo_cache on a ~110m grid — every staffed workplace has a
 * postcode within 2km, and an ingest run sees the same few hundred sites.
 */
export async function ukPostcodeNear(lat: number, lng: number): Promise<boolean> {
  const key = `rev:${lat.toFixed(3)},${lng.toFixed(3)}`;

  const mem = MEM.get(key);
  if (mem !== undefined) return mem !== null;

  const cached = await dbGet(key);
  if (cached !== undefined) {
    MEM.set(key, cached);
    return cached !== null;
  }

  const d = await fetchJson(
    `https://api.postcodes.io/postcodes?lon=${lng}&lat=${lat}&radius=2000&limit=1`
  );
  // Network failure ≠ "no postcode here". Deny the point for THIS run (dropping
  // a UK job on a blip is recoverable next ingest; admitting an Irish one is
  // wrong forever) but never CACHE the denial.
  if (d === null) return false;
  const results = d?.result as Array<Record<string, unknown>> | null | undefined;
  const hit = Array.isArray(results) ? results[0] : undefined;

  const entry: CacheEntry =
    hit && typeof hit.latitude === "number" && typeof hit.longitude === "number"
      ? {
          name: typeof hit.postcode === "string" ? hit.postcode : key,
          country: "GB",
          lat: hit.latitude,
          lng: hit.longitude,
          source: "postcodes.io",
        }
      : null;

  MEM.set(key, entry);
  void dbPut([{ key, entry, source: entry ? "postcodes.io:rev" : "postcodes.io:rev-miss" }]);
  return entry !== null;
}

/**
 * Resolve the USER's origin: a UK postcode ("B1 1AA", "B1") or a town name.
 * Returns null when we can't place them — the caller must then refuse to run a
 * radius search rather than silently searching the whole country
 * (lib/job-search/postcode.ts documents why that failure must be loud).
 */
export async function resolveOrigin(input: string): Promise<GeoPoint | null> {
  const raw = input?.trim();
  if (!raw) return null;
  const hit = await geocodeUk(raw);
  return hit ? { lat: hit.lat, lng: hit.lng } : null;
}

/**
 * Pre-resolve many queries at once, capped at 5 in flight.
 *
 * The ingest worker sees thousands of postings per run. Resolving them one at a
 * time would mean thousands of sequential HTTP round-trips (~30 min of pure
 * latency); firing them all at once would hammer a free public service. Five is
 * polite and finishes the long tail of a run in seconds.
 *
 * Bulk-loads the DB cache first (one query per 200 keys) so a warm corpus costs
 * ZERO postcodes.io calls.
 */
export async function warmCache(queries: string[], concurrency = 5): Promise<void> {
  const keys = Array.from(
    new Set(queries.map((q) => normalise(q)).filter((k) => k.length > 0))
  );

  // Anything the gazetteer or memory already knows needs no network and no DB.
  const unknown: string[] = [];
  for (const key of keys) {
    if (MEM.has(key)) continue;
    const gaz = lookupUkPlace(key);
    if (gaz) {
      MEM.set(key, gaz);
      continue;
    }
    unknown.push(key);
  }
  if (unknown.length === 0) return;

  const fromDb = await dbGetMany(unknown);
  const toFetch: string[] = [];
  for (const key of unknown) {
    if (fromDb.has(key)) MEM.set(key, fromDb.get(key) as CacheEntry);
    else toFetch.push(key);
  }
  if (toFetch.length === 0) return;

  const writes: Array<{ key: string; entry: CacheEntry; source: string }> = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= toFetch.length) return;
      const key = toFetch[i];
      let hit: ResolvedPlace | null = null;
      try {
        hit = looksLikePostcode(key) ? await postcodeLookup(key) : await placesLookup(key);
      } catch {
        hit = null; // never throw out of a warm pass
      }
      MEM.set(key, hit);
      writes.push({ key, entry: hit, source: hit ? "postcodes.io" : "postcodes.io:miss" });
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, toFetch.length)) }, () => worker())
  );

  await dbPut(writes);
}

/** Test/ops hook — drops the in-process cache. Does not touch the DB cache. */
export function clearMemoryCache(): void {
  MEM.clear();
}
