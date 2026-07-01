import PageHeader from "../_components/PageHeader";
import RolesClient from "./_components/RolesClient";
import { listSearches, listShortlist, listRuns } from "@/app/actions/searches";

export const dynamic = "force-dynamic";

export default async function RolesPage() {
  const searches = await listSearches();
  const activeId = searches[0]?.id ?? null;
  const [shortlist, runs] = activeId
    ? await Promise.all([listShortlist(activeId), listRuns(activeId, 5)])
    : [[], []];

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
      />
    </div>
  );
}
