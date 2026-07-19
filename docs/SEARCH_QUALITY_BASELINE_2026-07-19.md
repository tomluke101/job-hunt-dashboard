# HuntHQ Search-Quality Baseline — 2026-07-19

**The scoreboard we never had.** Built so the real fixes get sequenced on evidence, not guesswork.
Every number below is from REAL searches run through the ACTUAL `runSearch()` pipeline against the
LIVE prod corpus + LIVE Reed/Adzuna + LIVE OpenAI semantic ranking. No mocks. Relevance graded by an
LLM judge (Haiku 4.5). Re-run any time: `npx tsx scripts/audit-search-quality.ts`.

Prod code at time of measurement: `dbc722a` (main). 10 searches, top-10 each, 58 results graded.

---

## TL;DR — the answer

**The binding constraint is NEITHER supply nor selection. It is a correctness bug that silently
returns ZERO results for ~30% of searches** — and it hits hourly-paid / blue-collar searches hardest.

1. 🔴 **A salary type-crash zeroes whole searches.** Adzuna returns *fractional* salaries
   (e.g. `18.77`, `52771.9`, `14.11`); `job_postings.salary_min/max` are `integer` columns; the
   **whole batch upsert fails** (`22P02 invalid input syntax for type integer`) the moment one
   fractional-salary job reaches the top-N — so **nothing is written and the user sees "no jobs."**
   Measured: **Warehouse/Leeds (22 relevant jobs kept → 0 shown), Electrician/Bristol (38 → 0),
   Care Assistant/Cardiff (54 → 0).** Not a supply problem, not a ranking problem — a write crash.

2. 🟠 **After that, SELECTION is the dominant lever** for searches that do return results. Where
   supply is richest (Data Analyst: 100% first-party + 100% semantic; Marketing Manager: 90%
   first-party), **on-target is still only ~20%**, because ranking floats *senior/specialist*
   variants above the plain requested role, and "remote" intent isn't enforced.

3. 🟡 **Supply is a real but sector-specific third lever.** First-party (the moat) is ≈0 for
   warehouse, teaching, care, trades, and graduate-specific roles — those sectors aren't on ATS
   boards. The known "London-shaped coverage" is more precisely **"white-collar-shaped coverage."**

**Single highest-leverage fix:** round salaries to integer before the posting upsert (a one-liner).
It converts ~30% of searches from *zero results* to *populated*. Everything else is invisible to
those users until this lands. Then attack selection (demote senior/specialist when the base role is
asked for; enforce remote intent).

---

## Scoreboard (baseline)

### Coverage / reliability across all 10 searches
| Metric | Value | Note |
|---|---|---|
| Searches returning **any** results | **6 / 10** | 3 zeroed by the salary crash, 1 genuine thin supply |
| Searches zeroed by the salary crash | **3 / 10** | Warehouse, Electrician, Care — 22/38/54 relevant jobs lost |

### Quality over the 6 searches that returned results (58 graded results)
| Metric | Value | Read |
|---|---|---|
| Relevance **on-target** | **12.1%** | judge is strict on seniority/specialism |
| Relevance **on-target + loosely-related** | **75%** | forgiving measure |
| **Off-target** | **25%** | wrong role/seniority/location |
| **Bullshit rate** (recruiter + dead-link + dup + wrong-loc) | **9.6%** | honest classification (see note) |
| — recruiter | 4.2% | **undercount** — detector misses agencies like "Academics" |
| — dead link | 2.1% | only **1 confirmed dead** (a first-party jsonld 404) |
| — wrong location | 3.3% | within-radius but wrong town, or foreign leak |
| — duplicate | 0% | cross-source dedupe is working |
| **First-party (ATS)** | 53.8% | but ranges 0%–100% by sector |
| **Semantic ranking fired** | 52.1% | tracks first-party — aggregator jobs get NO semantic score |
| **Salary listed** | 66.3% | weak on first-party (many ATS jobs "no salary") |

> **Dead-link honesty note:** the first pass flagged 8 "dead" links; **7 were Adzuna `redirect_url`s
> returning HTTP 403 — that is bot-blocking on Adzuna's tracking redirect, not a dead posting.** They
> are re-classified as "blocked / unverifiable" and excluded from the bullshit rate. Only **1** link
> (a first-party jsonld) was a confirmed 404. The scoreboard script now classifies 401/403/429 as
> `blocked`, and only 404/410/5xx as `dead`.

### Per-search
| # | Search | Results | On-target | On+loose | Off | First-party | Semantic | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | Marketing Manager / London | 10 | 20% | 80% | 20% | 90% | 80% | rich supply, ranking floats senior/specialist |
| 2 | Actuarial Analyst / Manchester | **0** | — | — | — | — | — | **genuine thin supply** (1 job pulled total) |
| 3 | Warehouse Operative / Leeds | **0** | — | — | — | — | — | **salary crash** (22 kept → 0) |
| 4 | Head of Finance / remote | 10 | 0% | 60% | 40% | 60% | 60% | **"remote" not enforced** — office roles UK-wide |
| 5 | Graduate Software Engineer / Birmingham | 8 | 12.5% | 50% | 50% | 62.5% | 62.5% | senior roles outrank grad; a US job leaked to #1 |
| 6 | Electrician / Bristol | **0** | — | — | — | — | — | **salary crash** (38 kept → 0) |
| 7 | Registered Nurse / Glasgow | 10 | 20% | 80% | 20% | 10% | 10% | aggregator-heavy; surrounding-town noise |
| 8 | Data Analyst / remote | 10 | 20% | 80% | 20% | 100% | 100% | best supplied; still senior/specialist float + not-remote |
| 9 | Care Assistant / Cardiff | **0** | — | — | — | — | — | **salary crash** (54 kept → 0) |
| 10 | Primary School Teacher / Sheffield | 10 | 0% | 100% | 0% | 0% | 0% | all "Academics" agency, all surrounding towns, none in Sheffield |

---

## Coverage spot-check (Adzuna ground-truth)

| Search | Adzuna market (30d) | Adzuna top-20 on-target | Our first-party corpus depth | Read |
|---|---|---|---|---|
| Marketing Manager / London | **1,436** | 6/20 | 39 | huge aggregator market; modest but real first-party depth |
| Warehouse Operative / Leeds | 76 | 0/20 | **0** | zero first-party warehouse supply; aggregator-only → crashed |
| Graduate SW Engineer / Birmingham | **0** | 0 | 0 | even Adzuna ≈0 for this exact phrase — genuinely thin market |
| Care Assistant / Cardiff | 50 | **16/20** | 4 | Adzuna has 16 good care jobs; we surfaced **0** (salary crash) |

**Interpretation:** where supply exists it is heavily aggregator-shaped for blue-collar/care roles —
which is exactly where the salary crash and recruiter noise bite. The moat (first-party) simply does
not cover these sectors yet. (Indeed/LinkedIn/Google Jobs were NOT queried — no public API; Adzuna
`count` is the available market proxy.)

---

## Defect list — RANKED BY USER PAIN

### 1. 🔴→✅ CRITICAL — Salary type-crash zeroes entire searches — **FIXED 2026-07-19**

> **✅ FIX LANDED (2026-07-19).** `toIntColumn()` now rounds every integer-bound column
> (`salary_min`/`salary_max`/`hybrid_days_office`/`quality_score` on `job_postings`, and the
> score columns on `job_shortlist`) at the write boundary in `lib/job-search/pipeline.ts`, so no
> source's fractional value can ever fail the atomic batch upsert again. The upsert failure is now
> surfaced into `sourceWarnings` (no more silent "no jobs"), plus a runtime invariant guard
> (`passedFilter > 0 ⇒ shortlisted > 0`) and a re-runnable regression gate in the audit (exit 3 on
> violation). **Proof — same 10 searches, re-run through the fixed pipeline:**
>
> | # | Search | kept | shortlisted BEFORE | shortlisted AFTER |
> |---|---|---|---|---|
> | 3 | Warehouse Operative / Leeds | 22 | **0** | **10** |
> | 6 | Electrician / Bristol | 38 | **0** | **10** |
> | 9 | Care Assistant / Cardiff | 54 | **0** | **10** |
>
> Searches returning results: **6/10 → 9/10** (#2 Actuarial stays 0 — genuine thin supply, kept=0).
> The root cause was confirmed narrow: `parseSalaryFromText`, `scoreQuality`, working-model days and
> all ranking scores were already `Math.round`ed; the *only* unrounded value reaching an integer
> column was Adzuna's raw API `salary_min`/`salary_max`. Fix is source-agnostic (single write
> chokepoint) so a future provider can't reintroduce it.

- **Symptom:** ~30% of searches return zero results despite ample relevant supply.
- **Cause:** Adzuna (and some parsed) salaries are fractional; `job_postings.salary_min/max` are
  `integer`; the **batched** `job_postings` upsert fails atomically (`22P02`), so `postingIdByKey`
  is empty → no shortlist rows → `shortlisted = 0`.
- **Evidence:** searches #3/#6/#9 kept 22/38/54 jobs → shortlisted 0; console shows
  `invalid input syntax for type integer: "18.77" / "52771.9" / "14.11"`.
- **Blast radius:** worst for hourly-paid sectors (warehouse, care, trades, some nursing) where
  fractional/hourly salaries are the norm — i.e. the exact non-graduate market.
- **Fix (one-liner, do NOT ship this chat):** `Math.round()` `salary_min`/`salary_max` (and audit
  `hybrid_days_office`, `quality_score` for the same class) before the posting upsert in
  `lib/job-search/pipeline.ts`. Add a regression assertion: kept > 0 ⇒ shortlisted > 0.
- **Bonus:** it is currently a bare `console.error` — the user gets a silent "no jobs". Surface it
  into `sourceWarnings` too (silent-failure rule).

### 2. 🟠 HIGH — Ranking floats senior/specialist variants above the requested base role
- **Symptom:** on-target only ~12–20% even where supply is rich.
- **Evidence:** "Marketing Manager" → *Senior Procurement Category Manager - Marketing* ranked #1,
  then three *Senior Product Marketing Manager*s. "Data Analyst" → Senior/Lead/Product Analyst
  variants. "Graduate Software Engineer" → Senior/Staff/Lead engineers above the one trainee role.
- **Cause:** no seniority-match or base-noun-precision term in the composite; the semantic axis
  rewards JD similarity, which a "Senior X" JD has in abundance. Nothing pulls the *plain* requested
  title up.
- **Fix direction:** a seniority-alignment signal (penalise seniority above the asked level unless
  the user asked senior) + a base-title exact/near-exact bonus.

### 3. 🟠 HIGH — "Remote" search intent is not enforced
- **Symptom:** remote searches surface office roles scattered across the UK; on-target=0 for Head of
  Finance/remote.
- **Cause:** a "remote" search runs `filter_mode: anywhere` (no distance filter) but does **not**
  constrain `working_model` to remote — so office-based roles everywhere pass.
- **Fix direction:** when the user picks remote, either hard-filter or strongly rank
  `working_model = remote`; make the criterion explicit in the editor.

### 4. 🟡 MEDIUM — Title filter admits adjacent/off-target roles + a location leak
- **Evidence:** "…Marketing" procurement roles and "Digital Trading Manager" passed the Marketing
  title filter; a Cloudflare **Washington DC** role (location "Distributed") ranked **#1** in the
  Birmingham graduate search.
- **Fix direction:** tighten core-noun matching for multi-word titles; treat "Distributed"/global
  location strings as non-UK unless a UK place resolves.

### 5. 🟡 MEDIUM — Recruiter detector under-catches on aggregator data
- **Evidence:** "Academics" (a well-known supply-teacher agency) filled **all 10** teacher results
  and was **not** flagged; measured recruiter rate (4.2%) is an undercount.
- **Fix direction:** extend the agency name/SIC list; the moat's zero-recruiter guarantee only holds
  for first-party — aggregator supply needs the ranking penalty to actually fire.

### 6. 🟡 MEDIUM — Supply gap in blue-collar / education / care / trades
- **Evidence:** first-party corpus depth 0 (warehouse Leeds, teacher Sheffield), 4 (care Cardiff);
  semantic ranking can't fire at all for these (aggregator jobs aren't embedded).
- **Fix direction:** sector-specific first-party sources (NHS Jobs, council/education boards,
  care-home groups) — or accept aggregator-primary for these and lean hard on defects #1/#2/#5.

### 7. 🟢 LOW — Regional searches return surrounding towns, not the named city
- **Evidence:** every Sheffield teacher result was Chesterfield/Rotherham/Doncaster/Barnsley/Wakefield
  — technically ≤25mi, but reads as "not my city". Same for Glasgow nursing.
- **Fix direction:** rank exact-town matches above within-radius neighbours; show distance on the card.

### 8. 🟢 LOW — Salary coverage weak on first-party
- Many ATS jobs show "no salary" (66% listed overall, lower on first-party). Not a bug; a
  completeness gap worth a JD-parse pass.

---

## Method (so the number is trustworthy)

- Runs the **real** `runSearch()` — same code, corpus, keys, and aggregators as a signed-in prod user.
- **Honesty guard:** preflight ABORTS if any source key is missing or the semantic axis can't fire,
  so the scoreboard can never silently run degraded.
- Signals read structurally off `job_shortlist` + `job_postings` (source, first-party, recruiter,
  `match_to_user_score` = semantic fired, salary, `place_name`/`country_code`/`distance_miles`,
  `source_url`). Link liveness is a real HTTP check. Relevance = Haiku 4.5 judge, one call per search.
- Runs against the Clerk **test user**; every test search is deleted after (verified: 0 rows remain).
- Cost of a full run: ~2 min, ≈ 14 Adzuna calls / 10 Reed calls / ~10 OpenAI embeddings / ~14 Haiku
  calls (well under a few pence + free-tier limits).

## Re-run
```
cd job-hunt-dashboard
npx tsx scripts/audit-search-quality.ts                # full: 10 searches + Adzuna coverage
npx tsx scripts/audit-search-quality.ts --searches=1,8  # subset by id
npx tsx scripts/audit-search-quality.ts --no-coverage   # skip Adzuna coverage
```
Raw per-result data (every signal, every judge verdict + reason) → `scripts/audit-results-latest.json`.
This is the **regression gate**: after any ranking/supply/bug fix, re-run and diff the scoreboard.
