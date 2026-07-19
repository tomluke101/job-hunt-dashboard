import PageHeader from "../_components/PageHeader";
import RolesClient from "./_components/RolesClient";
import { listSearches, listShortlist, listRuns, countShortlistByState } from "@/app/actions/searches";

export const dynamic = "force-dynamic";

// The Run Search button triggers Reed + Adzuna pull + Companies House
// enrichment + ranking in one server action, plus a post-response background
// enrichment sweep (next/server `after`). Vercel Pro allows up to 300s; on
// Hobby this caps to the plan limit (60s), which is still fine — the main
// pipeline uses ~50s and the sweep just gets less time.
export const maxDuration = 300;

export default async function RolesPage() {
  const searches = await listSearches();
  const activeId = searches[0]?.id ?? null;
  const [shortlist, runs, counts] = activeId
    ? await Promise.all([listShortlist(activeId), listRuns(activeId, 5), countShortlistByState(activeId)])
    : [[], [], { new: 0, interested: 0, applied: 0, rejected_user: 0, deleted: 0 }];

  return (
    <div className="p-8">
      <PageHeader
        title="Roles"
        description="Job discovery, ranked and reasoned. Fewer jobs, all worth reading."
      />
      <RolesClient
        initialSearches={searches}
        initialActiveId={activeId}
        initialShortlist={shortlist}
        initialRuns={runs}
        initialCounts={counts}
      />
    </div>
  );
}
