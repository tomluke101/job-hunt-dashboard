import { getApplications } from "@/app/actions/applications";
import { getSavedCoverLetters, type SavedCoverLetter } from "@/app/actions/cover-letters";
import { getSavedTailoredCVs, type SavedTailoredCV } from "@/app/actions/cv-tailoring";
import PageHeader from "@/app/_components/PageHeader";
import ApplicationTable from "./_components/ApplicationTable";

export default async function TrackerPage() {
  const [applications, letters, savedCVs] = await Promise.all([
    getApplications(),
    getSavedCoverLetters(),
    getSavedTailoredCVs(),
  ]);

  const coverLetterMap = letters.reduce<Record<string, SavedCoverLetter>>((acc, l) => {
    if (l.application_id && !acc[l.application_id]) acc[l.application_id] = l;
    return acc;
  }, {});

  const tailoredCVMap = savedCVs.reduce<Record<string, SavedTailoredCV>>((acc, c) => {
    if (c.application_id && !acc[c.application_id]) acc[c.application_id] = c;
    return acc;
  }, {});

  return (
    <div className="p-8">
      <PageHeader
        title="Applications"
        description="Track every role you've applied to"
      />
      <ApplicationTable
        initialApps={applications}
        initialCoverLetterMap={coverLetterMap}
        initialTailoredCVMap={tailoredCVMap}
      />
    </div>
  );
}
