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

### 2. 🟠→✅ HIGH — Ranking floats senior/specialist variants above the requested base role — **FIXED 2026-07-19**

> **✅ FIX LANDED (2026-07-19).** New `lib/job-search/seniority-align.ts` adds two pure, EXPLAINED
> signals to the composite, applied post-blend at full strength (the same place the must-have bonus
> rides — so the semantic axis can't dilute them):
> 1. **Base-title bonus** — a job whose title (seniority words stripped) IS the requested base role
>    gets **+10**; the base role plus a specialiser ("Senior Product Marketing Manager" for
>    "Marketing Manager") gets **+4**.
> 2. **Over-seniority penalty** — a job more senior than the asked level loses **−6 per level**
>    (cap −18). The asked level is read from what the user ACTUALLY searched (the experience-level
>    filter → keywords → least-senior target chip), so a search that IS for a senior/lead/director
>    role penalises nothing at that level ("unless the user asked senior").
>
> Both reuse the SAME seniority classifier (`classify.ts`) and stemmer/seniority-markers
> (`text.ts`/`title-match.ts`) the pipeline already classifies and filters with, so the ranking
> seniority can never disagree with the one shown on the card. Surfaced in `ranking_explanation`
> (`base_title_match`, `base_title_bonus`, `seniority_penalty`, asked/job seniority index).
>
> **Proof — SAME live corpus, ranking re-run before vs after (controls for live-data drift):**
>
> | # | Search | on-target BEFORE | on-target AFTER | what moved |
> |---|---|---|---|---|
> | 1 | Marketing Manager / London | **10%** (1/10), off 30% | **40%** (4/10), off **0%** | Spotify exact "Marketing Manager UK/IE" **#5 → #1**; the *Senior Procurement Category Manager - Marketing* and three *Senior Product Marketing Manager*s that held #1–#4 all sank below the plain title |
> | 8 | Data Analyst / remote | 20% | 10%* | plain "Data Analyst" **#10 → #1**; Senior/Lead variants in the top-10 cut **5 → 2**, and **0** left in the top-3 |
>
> \* #8's headline on-target is a single-job flip and is **pinned by the still-open remote defect #3**,
> not by seniority: the judge grades nearly every #8 result "loosely_related" purely for *not remote*,
> and flipped its verdict on the *identical* Autotrader/Manchester job between the two runs. The
> seniority REORDER is what the deterministic evidence above shows fired correctly. #8 will only clear
> on the headline metric once #3 (enforce remote intent) lands.
>
> **Gate:** full 10-search suite re-run green (exit 0) — every search with kept>0 still shortlisted>0;
> #3/#6/#9 stay populated (defect #1's salary-int fix intact). Re-run: `npx tsx scripts/audit-search-quality.ts`.

- **Symptom:** on-target only ~12–20% even where supply is rich.
- **Evidence:** "Marketing Manager" → *Senior Procurement Category Manager - Marketing* ranked #1,
  then three *Senior Product Marketing Manager*s. "Data Analyst" → Senior/Lead/Product Analyst
  variants. "Graduate Software Engineer" → Senior/Staff/Lead engineers above the one trainee role.
- **Cause:** no seniority-match or base-noun-precision term in the composite; the semantic axis
  rewards JD similarity, which a "Senior X" JD has in abundance. Nothing pulls the *plain* requested
  title up.
- **Fix direction:** a seniority-alignment signal (penalise seniority above the asked level unless
  the user asked senior) + a base-title exact/near-exact bonus.

### 3. 🟠→✅ HIGH — "Remote" search intent is not enforced — **FIXED 2026-07-19**

> **✅ FIX LANDED (2026-07-19).** New `lib/job-search/remote-align.ts` adds a remote-intent detector
> and enforcement, wired into `pipeline.ts`:
> 1. **Intent** — `wantsRemote()` is TRUE only when the search accepts remote AND has de-selected
>    office (what the editor writes when the user picks the Remote chip). The default all-three search
>    is untouched, so every location search is a provable no-op.
> 2. **Hard filter** — the leak was NOT the working-model filter (it already drops KNOWN office/hybrid
>    roles); it was the `include_unknown` pass. A town-anchored office role whose JD never literally
>    says "office-based" classifies as `working_model: "unknown"` and sailed straight through. On a
>    remote search an unknown-model job now keeps that pass ONLY if it is positively remote
>    (`isRemoteEligible`: geo `is_remote`, JD-derived remote model, provider flag, or a remote token —
>    and never `is_foreign`). Foreign roles are also dropped explicitly (nationwide searches skip the
>    distance block where the foreign drop normally lives). Counted as a new `remote_intent` drop.
> 3. **Rank** — `remoteAlignment` floats a confirmed-remote job above a same-composite ambiguous one
>    (bonus 10, peer of the base-title bonus). Surfaced in `ranking_explanation` (`remote_intent`,
>    `remote_confirmed`, `remote_bonus`).
>
> The audit's two remote searches now express remote intent the way a real user does
> (`working_model.accepted = ["remote"]`), and the relevance judge is fed the job's working model so a
> confirmed-remote role listing a head-office city is no longer mis-graded "not remote" (the exact
> confusion this defect was about — it was under-counting correctly-enforced results).
>
> **Proof — same live corpus, before vs after:**
>
> | # | Search | on-target BEFORE | on-target AFTER | remote-confirmed | office roles dropped |
> |---|---|---|---|---|---|
> | 4 | Head of Finance / remote | **0%** | **29%** (2/7) | 0% → **100%** | `remote_intent` = 49 |
> | 8 | Data Analyst / remote | 10%* | **33%** (2/6) | ~10% → **100%** | `remote_intent` = 77 |
>
> Every surfaced result on both searches is now positively remote; the remaining off-targets are
> GENUINE (a Debt-Finance specialism, a no-experience placement programme, a £23k outsourced role) —
> not location artifacts. \* #8's headline was previously pinned by this very defect (per #2's note).
>
> **Gate:** full 10-search suite re-run green (exit 0). All 7 location searches show `remote_intent: 0`
> (enforcement is a no-op for them) and their kept→shortlisted counts are unchanged
> (#3/#6/#9 still 22/38/54 → 10 — defect #1 intact). Re-run: `npx tsx scripts/audit-search-quality.ts`.

- **Symptom:** remote searches surface office roles scattered across the UK; on-target=0 for Head of
  Finance/remote.
- **Cause:** a "remote" search runs `filter_mode: anywhere` (no distance filter) but does **not**
  constrain `working_model` to remote — so office-based roles everywhere pass. Precisely: the KNOWN
  office roles were already dropped; the ones leaking through were classified `unknown` and rescued by
  `include_unknown`.
- **Fix direction:** when the user picks remote, either hard-filter or strongly rank
  `working_model = remote`; make the criterion explicit in the editor.

### 4. 🟡→✅ MEDIUM — Title filter admits adjacent/off-target roles + a location leak — **FIXED 2026-07-20**

> **✅ FIX LANDED (2026-07-20).** Two independent tightenings, each with a deterministic
> pure-unit proof (`scripts/verify-selection-signals.ts`, no keys/network) AND a live-corpus
> confirmation.
>
> **(a) Multi-word title precision** — `lib/job-search/title-match.ts`. The old multi-word rule
> was "title contains the role noun AND *any* qualifier *anywhere*", so a qualifier that did not
> actually modify the noun still passed. The role noun's qualifier must now genuinely MODIFY it:
> 1. **One qualifier** → it must sit in the SAME PART as the role noun (parts split on the
>    comma / slash / brackets / SPACED dash an employer uses to bolt on a department tag). This
>    kills the detached-tag case — *"Senior Procurement Category Manager **- Marketing**"* — while
>    still keeping an inserted modifier (*"Software Development Engineer"* for "Software Engineer";
>    software + engineer share the part).
> 2. **Two+ qualifiers** → at least one must be ADJACENT to the role noun (its own modifier —
>    immediately before, or immediately after when the noun leads the part). This kills
>    *"Digital Trading Manager"* for a "Digital Marketing Manager" chip (only the peripheral
>    "digital" matched; the noun's own modifier "trading" is off-target) while still accepting
>    *"Construction Manager"* and *"Site Manager"* for a "Construction Site Manager" chip.
>
> It is the SAME `titleRelevantAny()` the pipeline (line 629) and the ATS-corpus prefilter
> (`ats-corpus.ts` line 120) both call, so an employer's own board and an aggregator apply the
> identical rule — no drift.
>
> **(b) "Distributed"/global location is non-UK unless a UK place resolves** — `lib/geo/parse.ts` +
> `pipeline.ts`. A Cloudflare Washington-DC role with `location_raw: "Distributed"` resolved to
> `country_code: null`, `is_remote: true`, and rode the `remoteOk = is_remote && acceptRemote`
> short-circuit straight past the Birmingham distance filter (marked `locationCorrect: true`, judged
> off_target). New `JobLocation.is_global_remote` is TRUE only when the sole location signal is a
> GLOBAL-remote qualifier (`Distributed` / `Anywhere` / `Worldwide` / `Global` / `International`) and
> **no** UK place or "UK"/"England" qualifier resolved. A place-anchored search now drops such a job
> (`filter_drops.location_global`) *before* the remote short-circuit. Deliberately scoped: a
> nationwide / remote search skips the distance block entirely, so a genuine remote role — and a
> plain "Remote" / "WFH" / "Home-based" / "Remote (UK)" one, none of which are global qualifiers — is
> completely untouched.
>
> **Proof — live re-run, same 10 searches (`npx tsx scripts/audit-search-quality.ts`):**
>
> | # | Search | what fired | effect |
> |---|---|---|---|
> | 1 | Marketing Manager / London | `title_irrelevant` +28, `location_global` = **2** | the "Senior Procurement Category Manager - Marketing" and "Digital Trading Manager" adjacents are gone; top-10 all genuine Marketing-Manager / marketing roles; **off_target = 0%**, wrongLoc 0 |
> | 5 | Graduate SW Engineer / Birmingham | `location_global` = **2** | the two Cloudflare **"Distributed"** roles — incl. *"Senior Solution Engineer … Washington DC"* — DROPPED before ranking; the US/global leak is gone; wrongLoc 0 |
>
> **Gate:** full 10-search suite green (exit 0); regression gate intact (every kept>0 ⇒ shortlisted>0);
> #3/#6/#9 still 22/38/54 → 10 (defect #1 intact); `location_global` = 0 on every other search,
> including the remote searches #4/#8 (enforcement is a provable no-op there). Deterministic proof of
> the exact keep/drop decisions (both documented FPs drop; "Software Development Engineer",
> "Construction/Site Manager", "Marketing Communications Manager" all keep; "Distributed" flagged,
> "Remote (UK)"/"London" not): `npx tsx scripts/verify-selection-signals.ts`.

- **Evidence:** "…Marketing" procurement roles and "Digital Trading Manager" passed the Marketing
  title filter; a Cloudflare **Washington DC** role (location "Distributed") ranked **#1** in the
  Birmingham graduate search.
- **Fix direction:** tighten core-noun matching for multi-word titles; treat "Distributed"/global
  location strings as non-UK unless a UK place resolves.

### 5. 🟡→✅ MEDIUM — Recruiter detector under-catches on aggregator data — **FIXED 2026-07-19**

> **✅ FIX LANDED (2026-07-19).** `lib/enrichment/recruiter-detect.ts` gained a curated block of the
> UK agencies that dominate the aggregator supply for the blue-collar / education / care / trades
> searches — matched by BRAND NAME at word boundaries, never by a bare sector word. The wiring was
> already correct and untouched: `recruiterPenalty()` (−12 rank) and the `hide_recruiters` selection
> filter both consume the flag (the filter via `enrichment.is_likely_recruiter`, which service.ts
> derives from the SAME `detectRecruiter()`), so extending the detector lights up both at once.
> Added: education (Academics, Teaching Personnel, TeacherActive, GSL / PK / Protocol / Vision for /
> Engage / Simply / Reeson Education, Career Teachers, Aspire People, Prospero, Tradewind, Trust
> Education, The Supply Desk), healthcare (Newcross, Medacs, Thornbury Nursing, Nurse Seekers),
> industrial/driving (Staffline, Extrastaff, Challenge-trg, Driver Hire), plus safe generic markers
> (`resourcing`, `personnel`, `<staffing-context> agency`, `search & selection`, `<nurse|care|…> seekers`).
>
> **The line held: a CARE-HOME OPERATOR or SCHOOL is the employer, not an agency.** Verified on the
> live corpus that Care Concern Group, Hallmark Care Homes, Meallmore, Mears Group, Ian Williams,
> Care UK, Bluebird Care and academy trusts (Oasis / United Learning / Harris / Ark) all stay
> **un-flagged**; a pure-unit proof (`scripts/verify-selection-signals.ts`) pins 23 real employers as
> clean and 23 agencies as flagged.
>
> **Proof — teacher #10 (the worst case: 100% agency supply), live re-run:**
>
> | metric | BEFORE | AFTER |
> |---|---|---|
> | recruiter_pct on #10 teacher | **0%** (Academics filled all 10, none flagged) | **90%** (9/10: Academics ×6, GSL ×2, Trust Education ×1) |
> | overall recruiter honesty (scoreboard mean) | 4.2% (an **undercount**) | **12.8%** (agencies previously invisible now counted + penalised) |
>
> A rising recruiter number here is the FIX, not a regression: the detector is now HONEST about
> agency supply, and each flagged agency takes the −12 rank penalty (and would be hidden if the user
> turns `hide_recruiters` on). For an all-agency market like teaching the penalty **demotes uniformly**
> rather than emptying the search (it defaults OFF) — expected, and why real first-party supply
> (defect #6) is the only thing that ends the agency dependence.

- **Evidence:** "Academics" (a well-known supply-teacher agency) filled **all 10** teacher results
  and was **not** flagged; measured recruiter rate (4.2%) is an undercount.
- **Fix direction:** extend the agency name/SIC list; the moat's zero-recruiter guarantee only holds
  for first-party — aggregator supply needs the ranking penalty to actually fire.
- **Known residuals (single-appearance long-tail, left un-flagged to avoid pattern creep):** bare
  "Search" (Search Consultancy trades as just "Search" — too generic to match safely), "Find Medical",
  "Cover People". The dominant agency (Academics) is fully caught.

### 6. 🟡 MEDIUM — Supply gap in blue-collar / education / care / trades
- **Evidence:** first-party corpus depth 0 (warehouse Leeds, teacher Sheffield), 4 (care Cardiff);
  semantic ranking can't fire at all for these (aggregator jobs aren't embedded).
- **Fix direction:** sector-specific first-party sources (NHS Jobs, council/education boards,
  care-home groups) — or accept aggregator-primary for these and lean hard on defects #1/#2/#5.

### 7. 🟢→✅ LOW — Regional searches return surrounding towns, not the named city — **FIXED 2026-07-19**

> **✅ FIX LANDED (2026-07-19).** New `lib/job-search/proximity-align.ts` adds one bounded, EXPLAINED
> proximity bonus to the composite, applied post-blend (peer of the base-title / remote bonuses):
> full strength (**+10**) at distance 0, decaying linearly to 0 at the search radius, so the exact
> town and its nearest neighbours float above jobs at the edge. It ranks on the `distance_miles` the
> pipeline already computed — now computed ONCE in the ranker and threaded onto the result so the
> number the bonus used is the exact number the card shows (no drift). Two hard no-ops, proven in the
> unit script: a nationwide / remote search (`isNationwide`) never reorders on distance, and an
> unplaceable job (pure-remote / country-only / unresolved → null distance) gets 0 — null is "cannot
> speak", never a penalty. Surfaced in `ranking_explanation` (`proximity_applies`, `proximity_bonus`,
> `distance_miles`, `place`) and on the card as a "6 mi away / In Sheffield" badge + a "Proximity" line.
>
> **Proof — same live corpus, nearest-town ordering before vs after:**
>
> | # | Search | exact-town job(s) BEFORE | AFTER |
> |---|---|---|---|
> | 7 | Registered Nurse / Glasgow | the two Glasgow (0 mi) roles at **#4 and #7** | **#2 and #3** — above every surrounding town (Ashgill/Cleghorn/Renton/Lanark/Falkirk); #1 is a *first-party* East Kilbride role at 6 mi, correctly held up by the +8 ATS bonus |
> | 10 | Primary School Teacher / Sheffield | Sheffield role at **#9** | floated **up** — reached **#2** in one run; proximity also pulls Rotherham (6 mi) up to tie Wakefield (21 mi) despite Wakefield's better salary/JD match |
>
> **Honest limit (by design):** the bonus is bounded so it CANNOT override a materially weaker base
> match — in a run where the only Sheffield teacher job had a genuinely weak JD match (match-to-search
> 37 vs 47 for a Rotherham role), +10 vs +7.6 didn't leapfrog a ~9-point base deficit, and shouldn't
> (a weak in-town role must not beat a strong nearby one). Teacher stays supply-bound (0 first-party,
> 100% agency); #7 orders honestly where the base is comparable, but only real first-party supply
> (defect #6) makes it *perfect*.
>
> **Gate:** full 10-search suite green (exit 0); proximity is a provable no-op on the remote searches
> (#4/#8) and did not regress the location searches; #3/#6/#9 stay populated (defect #1 intact).
> Re-run: `npx tsx scripts/audit-search-quality.ts`; pure-unit proof: `npx tsx scripts/verify-selection-signals.ts`.

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
