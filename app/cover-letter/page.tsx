import { Suspense } from "react";
import PageHeader from "../_components/PageHeader";
import CoverLetterGenerator from "./_components/CoverLetterGenerator";
import { getApiKeys } from "@/app/actions/api-keys";
import { getTaskPreferences } from "@/app/actions/preferences";
import { getApplications } from "@/app/actions/applications";
import { getCVs, getProfile, getCoverLetterPrefs } from "@/app/actions/profile";
import { getSavedCoverLetters } from "@/app/actions/cover-letters";
import type { Provider } from "@/lib/ai-providers";

export default async function CoverLetterPage() {
  const [savedKeys, preferences, applications, cvs, recentLetters, profile, clPrefs] = await Promise.all([
    getApiKeys(),
    getTaskPreferences(),
    getApplications(),
    getCVs(),
    getSavedCoverLetters(),
    getProfile(),
    getCoverLetterPrefs(),
  ]);

  const connectedProviders = savedKeys.map((k) => k.provider as Provider);
  const currentProvider = preferences["cover-letter"];

  return (
    <div className="p-8">
      <PageHeader
        title="Cover Letters"
        description="AI-generated cover letters tailored to each role — written in your voice"
      />

      <div className="mt-6">
        <Suspense fallback={null}>
          <CoverLetterGenerator
            applications={applications}
            cvs={cvs}
            currentProvider={currentProvider}
            connectedProviders={connectedProviders}
            recentLetters={recentLetters}
            profile={profile}
            clPrefs={clPrefs}
          />
        </Suspense>
      </div>
    </div>
  );
}
