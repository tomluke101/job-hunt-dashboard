-- HuntHQ — AI ranking: semantic embeddings. Apply in the Supabase SQL editor.
--
-- The ranking so far is heuristic: keyword/title overlap, a quality score, salary
-- fit, first-party bonus. That cannot tell that "help SMEs move to the cloud" and
-- "Solutions Engineer, cloud migration for mid-market" are the SAME job in different
-- words — it only sees the words. Embeddings can: they place a JD and a user's
-- plain-English description in the same vector space, so semantic closeness becomes
-- a number we can rank on.
--
-- Model: OpenAI text-embedding-3-large, 3072 dimensions (locked architecture).
--
-- WHY NO ANN INDEX. pgvector's ivfflat/hnsw indexes cap at 2000 dimensions for the
-- `vector` type; 3072 is over that. We deliberately do NOT reduce the dimension
-- (the smaller models/dims are measurably worse on nuanced queries — a false
-- economy for the one feature whose whole job is nuance). Instead we never scan the
-- whole corpus by vector: the pipeline has ALREADY narrowed to a small candidate
-- set (title filter + geography + the hard filters) before it asks for similarity,
-- so match_job_embeddings() does an exact cosine scan over a few hundred ids at
-- most — sub-millisecond, no index needed. Semantic search is a RE-RANK within the
-- filtered set, never the retrieval step.
--
-- Idempotent. Safe to re-run.

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- 1. JD embeddings on the corpus.
--
-- jd_embedding_hash is the cache key: it is the sha256 of the exact text we
-- embedded (title + company + truncated JD). If the JD is unchanged the hash is
-- unchanged and the backfill skips it — so re-running the embedder is free, and a
-- genuinely edited JD re-embeds automatically. Without the hash we'd either
-- re-embed the whole corpus every run (money) or never notice an edited JD (stale
-- vectors).
-- ---------------------------------------------------------------------------
alter table job_postings
  add column if not exists jd_embedding vector(3072),
  add column if not exists jd_embedding_hash text,
  add column if not exists jd_embedded_at timestamptz;

-- Partial index: the backfill's hot query is "which postings still need embedding".
create index if not exists job_postings_needs_embedding_idx
  on job_postings(last_seen_at desc)
  where jd_embedding is null;

-- ---------------------------------------------------------------------------
-- 2. The query-side embedding: the user's search description, embedded once at
--    save and cached. This is the vector every JD is compared against.
-- ---------------------------------------------------------------------------
alter table job_searches
  add column if not exists description_embedding vector(3072),
  add column if not exists description_embedding_hash text,
  add column if not exists description_embedded_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Similarity RPC — cosine similarity computed IN THE DATABASE.
--
-- The alternative is shipping every candidate's 3072-float vector to the app and
-- doing the maths in JS: ~30 KB of JSON text per row, hundreds of rows, megabytes
-- per search. Instead we pass the search id and the candidate posting ids; the
-- function reads the search's stored description_embedding and returns one float
-- per posting. Only floats cross the wire.
--
--   <=> is pgvector's cosine DISTANCE, so similarity = 1 - distance, in [0, 2]
--   (0 = identical direction, 1 = orthogonal). For unit-norm embeddings (OpenAI's
--   are L2-normalised) it lands in [0, 2] but in practice [0, ~1] for real text.
--
-- Postings with a NULL jd_embedding (not yet backfilled, or an aggregator job we
-- don't embed) are simply absent from the result — the caller treats absence as
-- "no semantic signal" and ranks them on the heuristic axes alone.
-- ---------------------------------------------------------------------------
create or replace function match_job_embeddings(
  p_search_id uuid,
  p_posting_ids uuid[]
)
returns table (posting_id uuid, similarity real)
language sql
stable
as $$
  select p.id as posting_id,
         (1 - (p.jd_embedding <=> s.description_embedding))::real as similarity
  from job_postings p
  cross join (
    select description_embedding
    from job_searches
    where id = p_search_id
  ) s
  where p.id = any(p_posting_ids)
    and p.jd_embedding is not null
    and s.description_embedding is not null;
$$;
