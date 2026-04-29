import { Suspense } from "react";
import PageHeader from "../_components/PageHeader";
import CVTailorClient from "./_components/CVTailorClient";
import ProviderSelector from "../_components/ProviderSelector";
import { getApiKeys } from "@/app/actions/api-keys";
import { getTaskPreferences } from "@/app/actions/preferences";
import { getApplications } from "@/app/actions/applications";
import { getCVs } from "@/app/actions/profile";
import { getSavedTailoredCVs, type SavedTailoredCV } from "@/app/actions/cv-tailoring";
import type { Provider } from "@/lib/ai-providers";

export default async function CVPage() {
  const [savedKeys, preferences, applications, cvs, savedCVs] = await Promise.all([
    getApiKeys(),
    getTaskPreferences(),
    getApplications(),
    getCVs(),
    getSavedTailoredCVs(),
  ]);

  const connectedProviders = savedKeys.map((k) => k.provider as Provider);
  // Per application, surface the most recent saved tailored CV so the client
  // can restore it when the user lands on /cv?applicationId=...
  const savedCVByApp: Record<string, SavedTailoredCV> = {};
  for (const cv of savedCVs) {
    if (cv.application_id && !savedCVByApp[cv.application_id]) {
      savedCVByApp[cv.application_id] = cv;
    }
  }

  return (
    <div className="p-8">
      <PageHeader
        title="CV Tailor"
        description="Adapt your CV to each role — every claim traced to your profile, no invented metrics."
      >
        <ProviderSelector
          task="cv-tailor"
          current={preferences["cv-tailor"]}
          connectedProviders={connectedProviders}
        />
      </PageHeader>

      <div className="mt-6">
        <Suspense fallback={null}>
          <CVTailorClient
            applications={applications}
            cvs={cvs}
            savedCVByApp={savedCVByApp}
          />
        </Suspense>
      </div>
    </div>
  );
}
