import { getApplications } from "@/app/actions/applications";
import { getSavedCoverLetters, type SavedCoverLetter } from "@/app/actions/cover-letters";
import PageHeader from "@/app/_components/PageHeader";
import ApplicationTable from "./_components/ApplicationTable";

export default async function TrackerPage() {
  const [applications, letters] = await Promise.all([
    getApplications(),
    getSavedCoverLetters(),
  ]);

  const coverLetterMap = letters.reduce<Record<string, SavedCoverLetter>>((acc, l) => {
    if (l.application_id && !acc[l.application_id]) acc[l.application_id] = l;
    return acc;
  }, {});

  return (
    <div className="p-8">
      <PageHeader
        title="Applications"
        description="Track every role you've applied to"
      />
      <ApplicationTable initialApps={applications} initialCoverLetterMap={coverLetterMap} />
    </div>
  );
}
