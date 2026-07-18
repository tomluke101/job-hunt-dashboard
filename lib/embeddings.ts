// Semantic embeddings — the query side of AI ranking.
//
// One model, one place. text-embedding-3-large at 3072 dimensions (the locked
// architecture): the smaller model and the reduced-dimension variants are
// measurably worse on nuanced queries, and nuance is the entire point of this
// feature, so the 6x saving is a false economy here.
//
// SERVER KEY ONLY. Unlike cover-letter / CV tailoring (which stay BYOK), ranking
// is core product — users pay us, we pay OpenAI. Never surface the model name in
// the UI.
//
// Everything here is best-effort by contract: if OPENAI_API_KEY is unset or a call
// fails, callers fall back to heuristic ranking. A search must never break because
// the embedding provider had a bad day — the single worst failure mode in this
// codebase is a search that silently returns nothing.

import OpenAI from "openai";
import { createHash } from "crypto";
import type { SearchCriteria } from "./job-search/types";

export const EMBEDDING_MODEL = "text-embedding-3-large";
export const EMBEDDING_DIMS = 3072;

// Front-load truncation. The first few thousand characters of a JD carry the role
// summary, responsibilities and requirements — the part that decides semantic
// match. Benefits blurb, EEO statements and application boilerplate sit at the end
// and add tokens (cost) without signal. 6000 chars ≈ 1500 tokens, well under the
// model's 8191-token limit, and it bounds the one-time corpus backfill cost.
const MAX_JD_CHARS = 6000;
const MAX_QUERY_CHARS = 4000;

// Similarity → 0-100 score calibration.
//
// Cosine similarity from text-embedding-3-large is compressed: a strong JD↔query
// match lands around 0.40-0.55, a loose one around 0.25-0.35, unrelated text
// around 0.10-0.20. Mapping raw cosine straight to a percentage would put even the
// best matches in the 40s. This linear stretch maps the useful band to [0, 100].
//
// These bounds are an initial calibration. scripts/verify-embeddings.ts prints the
// real similarity distribution over the live corpus — tune SIM_FLOOR/SIM_CEIL to
// what the data actually shows before trusting the absolute score.
export const SIM_FLOOR = 0.2;
export const SIM_CEIL = 0.55;

let client: OpenAI | null = null;
function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set — semantic embeddings are unavailable. Ranking falls back to heuristics."
    );
  }
  if (!client) client = new OpenAI({ apiKey });
  return client;
}

export function embeddingsConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/** The exact text we embed for a job posting. Order matters: title first, it's the
 *  densest signal; company next; then the (truncated) JD body. */
export function buildJdEmbeddingInput(
  title: string | null | undefined,
  company: string | null | undefined,
  jdText: string | null | undefined
): string {
  const t = (title ?? "").trim();
  const c = (company ?? "").trim();
  const jd = (jdText ?? "").trim().slice(0, MAX_JD_CHARS);
  return [t, c, jd].filter(Boolean).join("\n");
}

/** The query vector represents the user's INTENT. Prefer their free-text
 *  description; fold in the concrete titles / keywords / name so a title-only
 *  search (no prose) still produces a meaningful query vector rather than nothing. */
export function buildQueryEmbeddingInput(
  criteria: SearchCriteria,
  description: string | null | undefined,
  name: string | null | undefined
): string {
  const parts: string[] = [];
  const desc = (description ?? "").trim();
  if (desc) parts.push(desc);
  if (criteria.target_titles?.length) parts.push(criteria.target_titles.join(", "));
  const kw = (criteria.keywords ?? "").trim();
  if (kw) parts.push(kw);
  const nm = (name ?? "").trim();
  // The name is a weak signal (often just "Data jobs") — only use it if nothing
  // better exists, so it can't dominate a real description.
  if (!parts.length && nm) parts.push(nm);
  return parts.join("\n").slice(0, MAX_QUERY_CHARS);
}

/** sha256 (truncated) of the embedded text — the cache key that lets us skip
 *  re-embedding unchanged text and re-embed genuinely changed text. */
export function embeddingHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** pgvector accepts a bracketed literal: '[0.1,0.2,...]'. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/** Map a cosine similarity in [0,1] to a 0-100 semantic score (see calibration). */
export function semanticScoreFromSimilarity(sim: number): number {
  const t = (sim - SIM_FLOOR) / (SIM_CEIL - SIM_FLOOR);
  return Math.max(0, Math.min(100, Math.round(t * 100)));
}

/** Embed one string. Throws if unconfigured or the call fails — callers decide
 *  whether that is fatal (it never should be for a search). */
export async function embedText(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text]);
  return vec;
}

/** Embed a batch in a single request. OpenAI returns one vector per input; we
 *  re-order by the returned `index` rather than trusting array position. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await getClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMS,
  });
  const out: number[][] = new Array(texts.length);
  for (const item of res.data) out[item.index] = item.embedding as number[];
  return out;
}
