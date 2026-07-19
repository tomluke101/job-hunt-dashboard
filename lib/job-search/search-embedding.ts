// Embed a search's query vector and cache it on job_searches.
//
// Called from two places, both idempotent via the hash:
//   • on save (create/update) — so the vector is warm before the first run;
//   • lazily at run time — so a search saved before this feature shipped, or one
//     whose save-time embed hasn't landed yet, still gets a vector on first run.
//
// Best-effort by contract: any failure (no key, provider down, migration not
// applied) leaves the search without a vector and returns { embedded: false }.
// The ranker then falls back to the heuristic axes. Saving and searching must
// never fail because embedding failed.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SearchCriteria } from "./types";
import { embeddingColumnsAvailable } from "./schema-guard";
import {
  embeddingsConfigured,
  buildQueryEmbeddingInput,
  embeddingHash,
  embedText,
  toVectorLiteral,
} from "@/lib/embeddings";

export interface EnsureSearchEmbeddingParams {
  searchId: string;
  criteria: SearchCriteria;
  description: string | null;
}

export interface EnsureSearchEmbeddingResult {
  /** True if a vector is present after this call (freshly written OR already current). */
  present: boolean;
  /** True if we actually called the embedding provider this time. */
  embedded: boolean;
  error?: string;
}

export async function ensureSearchEmbedding(
  supabase: SupabaseClient,
  params: EnsureSearchEmbeddingParams
): Promise<EnsureSearchEmbeddingResult> {
  if (!embeddingsConfigured()) return { present: false, embedded: false, error: "no-openai-key" };
  if (!(await embeddingColumnsAvailable(supabase))) {
    return { present: false, embedded: false, error: "migration-not-applied" };
  }

  const queryText = buildQueryEmbeddingInput(params.criteria, params.description);
  if (!queryText.trim()) {
    // Nothing to embed (a pure filter/browse search with no titles or prose). Not
    // an error — this search simply has no semantic query, and ranks heuristically.
    return { present: false, embedded: false };
  }
  const hash = embeddingHash(queryText);

  try {
    const { data: row } = await supabase
      .from("job_searches")
      .select("description_embedding_hash")
      .eq("id", params.searchId)
      .single();
    // Already current: the exact same query text is embedded. Skip the call.
    if (row?.description_embedding_hash === hash) {
      return { present: true, embedded: false };
    }

    const vec = await embedText(queryText);
    const { error } = await supabase
      .from("job_searches")
      .update({
        description_embedding: toVectorLiteral(vec),
        description_embedding_hash: hash,
        description_embedded_at: new Date().toISOString(),
      })
      .eq("id", params.searchId);
    if (error) return { present: false, embedded: false, error: error.message };
    return { present: true, embedded: true };
  } catch (e) {
    return { present: false, embedded: false, error: e instanceof Error ? e.message : String(e) };
  }
}
