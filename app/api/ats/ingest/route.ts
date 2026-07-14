// Scheduled ATS ingest. Driven by the Vercel cron in vercel.json.
//
// The corpus is only as fresh as the last ingest. The whole freshness advantage over
// Reed/Adzuna — seeing a job the HOUR the employer posts it — evaporates if this
// only ever runs when a human remembers to run it from a laptop.

import { NextResponse } from "next/server";
import { listPollableBoards } from "@/lib/ats/registry";
import {
  ingestBoards,
  assertProviderHealth,
  assertNoSilentTruncation,
  recordIngestRun,
} from "@/lib/ats/ingest";

// Vercel caps a serverless function at 300s on Pro. Boards are polled
// oldest-first, so a run that doesn't finish the registry still makes forward
// progress and the next run picks up where it left off.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorised(req: Request): boolean {
  // Vercel signs its own cron invocations with CRON_SECRET as a bearer token.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorised(req)) {
    // 401 rather than 404: this endpoint mutates shared data, and a misconfigured
    // CRON_SECRET must fail loudly, not look like a missing route.
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const boards = await listPollableBoards(400);
  if (!boards.length) {
    return NextResponse.json(
      { ok: false, error: "registry empty — run scripts/discover-ats.ts" },
      { status: 500 }
    );
  }

  const stats = await ingestBoards(boards, {
    // Leave headroom under maxDuration so the run can still write its audit row.
    budgetMs: 270_000,
    // ⚠️ STAYS AT 4 — AND THAT IS A SUPPLY DECISION, NOT A POLITENESS ONE.
    //
    // The registry went 52 -> 94 boards on 2026-07-14 and a full ingest at
    // concurrency 4 now takes 240-300s across runs — i.e. it STRADDLES this 270s
    // budget and will sometimes not finish. The obvious fix is to poll more boards at
    // once. It was tried, and measured:
    //
    //     concurrency 4 -> 296s, workday 3854 jobs, no truncation
    //     concurrency 6 -> 152s, workday 2653 jobs, Barclays TRUNCATED
    //     concurrency 8 -> 151s, workday 2353 jobs, Barclays + AstraZeneca TRUNCATED
    //
    // Polling harder gets us THROTTLED by Workday, and the throttling does not arrive
    // as an error — it arrives as a QUIETLY HALVED JOB COUNT on our biggest employers.
    // A 2x speed-up that costs 40% of Barclays and AstraZeneca is not a speed-up.
    //
    // So this run will now exhaust its clock and poll ~85 of 94 boards. That is
    // ACCEPTABLE and it is not silent: boards are polled oldest-first, so the next run
    // continues where this one stopped, and assertNoSilentTruncation() reports the
    // exhaustion as a problem, which makes this route return 500 and show up in
    // Vercel's cron failure log. Full refresh takes two nights instead of one.
    //
    // The real fix is to SHARD the cron (poll a slice of the registry per invocation)
    // or raise maxDuration — not to hammer Workday. Tom's call; it costs money.
    concurrency: 4,
    trigger: "cron",
  });

  // Both assertions, not just provider health. A board served in part is as silent
  // a supply loss as a provider serving nothing.
  const problems = [...assertProviderHealth(stats), ...assertNoSilentTruncation(stats)];
  await recordIngestRun(stats, "cron", problems);

  // A provider returning zero across every board is a FAULT, not an empty job
  // market — report it as one so it shows up in Vercel's cron failure log rather
  // than passing silently for ten days.
  return NextResponse.json(
    {
      ok: problems.length === 0,
      problems,
      boards_polled: stats.boards_polled,
      jobs_seen: stats.jobs_seen,
      jobs_upserted: stats.jobs_upserted,
      dropped_foreign: stats.jobs_dropped_foreign,
      provider_counts: stats.provider_counts,
      truncated_boards: stats.truncated_boards,
      budget_exhausted: stats.budget_exhausted,
      elapsed_ms: stats.elapsed_ms,
    },
    { status: problems.length ? 500 : 200 }
  );
}
