// Embed every ATS-corpus JD so search-time semantic ranking has something to match
// against. The query side (the user's description) is embedded on save; this is the
// document side.
//
//   npx tsx scripts/backfill-embeddings.ts             # DRY RUN — counts + $ estimate, spends nothing
//   npx tsx scripts/backfill-embeddings.ts --commit    # embed + write (COSTS MONEY)
//   npx tsx scripts/backfill-embeddings.ts --commit --limit 200   # small paid smoke test first
//
// Resumable + cheap to re-run: it only touches postings whose jd_embedding is
// missing or whose JD text has changed (the sha256 hash guards that), so a re-run
// after new ingest embeds only the new jobs. Nothing is ever re-embedded for free.
//
// Only ATS sources are embedded — that's the moat, and the only supply the semantic
// axis scores. Reed/Adzuna rows are deliberately skipped (see pipeline.ts).

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Env: cwd .env.local first (wins), then the canonical HuntHQ key store (OneDrive
// clone) as a fallback — identical to audit-search-quality.ts. The Desktop clone's
// .env.local carries only Clerk+Supabase, so without the fallback OPENAI_API_KEY is
// absent and the --commit run aborts on the embeddingsConfigured() guard. Never
// writes secrets anywhere.
function loadEnvFiles(paths: string[]) {
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v; // first file wins
    }
  }
}
loadEnvFiles([
  resolve(process.cwd(), ".env.local"),
  "C:/Users/tomlu/OneDrive/Desktop/Money/Job hunt SaaS/job-hunt-dashboard/.env.local",
]);

import { createServerSupabaseClient } from "../lib/supabase-server";
import { ATS_SOURCES } from "../lib/job-search/types";
import {
  EMBEDDING_MODEL,
  buildJdEmbeddingInput,
  embeddingHash,
  embedTexts,
  toVectorLiteral,
  embeddingsConfigured,
} from "../lib/embeddings";

const COMMIT = process.argv.includes("--commit");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

// $ per 1M tokens for text-embedding-3-large (Jan 2026). Kept here purely for the
// estimate; billing is whatever OpenAI charges.
const USD_PER_1M_TOKENS = 0.13;
// Rough tokens ≈ chars / 4. Good enough to price the run, never used for truncation.
const CHARS_PER_TOKEN = 4;
const EMBED_BATCH = 96; // texts per OpenAI request
const WRITE_CONCURRENCY = 8; // parallel row updates per batch

interface Candidate {
  id: string;
  input: string;
  hash: string;
}

async function loadCandidates(): Promise<{ candidates: Candidate[]; scanned: number; upToDate: number }> {
  const supabase = createServerSupabaseClient();
  const candidates: Candidate[] = [];
  let scanned = 0;
  let upToDate = 0;

  // Paginate: PostgREST caps at 1000 rows and truncates silently. A backfill that
  // covers 1000 of 11,600 rows leaves the rest with no semantic signal forever.
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("job_postings")
      .select("id, title, company, jd_text, jd_embedding_hash")
      .in("source", ATS_SOURCES as unknown as string[])
      .range(from, from + 999);
    if (error) throw new Error(`read job_postings: ${error.message}`);
    const rows = data ?? [];
    if (rows.length === 0) break;

    for (const r of rows) {
      scanned++;
      const input = buildJdEmbeddingInput(
        r.title as string,
        r.company as string,
        r.jd_text as string
      );
      if (!input.trim()) continue; // nothing to embed
      const hash = embeddingHash(input);
      // Hash present and matching ⇒ vector already current (hash + vector are always
      // written together). Skip.
      if ((r.jd_embedding_hash as string | null) === hash) {
        upToDate++;
        continue;
      }
      candidates.push({ id: r.id as string, input, hash });
      if (candidates.length >= LIMIT) return { candidates, scanned, upToDate };
    }
    if (rows.length < 1000) break;
  }
  return { candidates, scanned, upToDate };
}

function estimate(candidates: Candidate[]): { tokens: number; usd: number } {
  const chars = candidates.reduce((n, c) => n + c.input.length, 0);
  const tokens = Math.round(chars / CHARS_PER_TOKEN);
  return { tokens, usd: (tokens / 1_000_000) * USD_PER_1M_TOKENS };
}

async function writeRow(id: string, vec: number[], hash: string): Promise<boolean> {
  const supabase = createServerSupabaseClient();
  const { error } = await supabase
    .from("job_postings")
    .update({
      jd_embedding: toVectorLiteral(vec),
      jd_embedding_hash: hash,
      jd_embedded_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    console.error(`  ✗ write ${id}: ${error.message}`);
    return false;
  }
  return true;
}

async function main() {
  console.log(`\nBackfill embeddings — model ${EMBEDDING_MODEL}`);
  console.log(`Mode: ${COMMIT ? "COMMIT (will spend)" : "DRY RUN (no spend)"}${LIMIT !== Infinity ? `, limit ${LIMIT}` : ""}\n`);

  const { candidates, scanned, upToDate } = await loadCandidates();
  const { tokens, usd } = estimate(candidates);

  console.log(`Scanned ${scanned} ATS postings — ${upToDate} already up to date.`);
  console.log(`Need embedding: ${candidates.length}`);
  console.log(`Estimated tokens: ~${tokens.toLocaleString()}  →  ~$${usd.toFixed(2)} (≈ £${(usd * 0.79).toFixed(2)})\n`);

  if (candidates.length === 0) {
    console.log("Nothing to do. ✅");
    return;
  }
  if (!COMMIT) {
    console.log("DRY RUN — no embeddings created, nothing written.");
    console.log("Re-run with --commit to spend the amount above.");
    return;
  }
  if (!embeddingsConfigured()) {
    throw new Error("OPENAI_API_KEY is not set — cannot embed. Aborting before spending anything.");
  }

  let embedded = 0;
  let failed = 0;
  const started = Date.now();

  for (let i = 0; i < candidates.length; i += EMBED_BATCH) {
    const batch = candidates.slice(i, i + EMBED_BATCH);
    let vectors: number[][];
    try {
      vectors = await embedTexts(batch.map((c) => c.input));
    } catch (e) {
      failed += batch.length;
      console.error(`  ✗ embed batch @${i}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // Write the batch with bounded concurrency.
    let cursor = 0;
    async function worker() {
      for (;;) {
        const k = cursor++;
        if (k >= batch.length) return;
        const ok = await writeRow(batch[k].id, vectors[k], batch[k].hash);
        if (ok) embedded++;
        else failed++;
      }
    }
    await Promise.all(Array.from({ length: WRITE_CONCURRENCY }, () => worker()));

    const done = Math.min(i + EMBED_BATCH, candidates.length);
    console.log(`  ${done}/${candidates.length} embedded (${failed} failed)`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\nDone: ${embedded} embedded, ${failed} failed, ${secs}s. ✅`);
  if (failed > 0) {
    console.log("Some rows failed — safe to re-run; only the unembedded ones will be retried.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
