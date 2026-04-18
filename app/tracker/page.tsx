import { getApplications } from "@/app/actions/applications";
import PageHeader from "@/app/_components/PageHeader";
import ApplicationTable from "./_components/ApplicationTable";

export default async function TrackerPage() {
  const applications = await getApplications();

  return (
    <div className="p-8">
      <PageHeader
        title="Applications"
        description="Track every role you've applied to"
      />
      <ApplicationTable initialApps={applications} />
    </div>
  );
}
