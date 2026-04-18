import { FileText } from "lucide-react";
import PageHeader from "../_components/PageHeader";
import ComingSoon from "../_components/ComingSoon";
import ProviderSelector from "../_components/ProviderSelector";
import { getApiKeys } from "@/app/actions/api-keys";
import { getTaskPreferences } from "@/app/actions/preferences";
import type { Provider } from "@/lib/ai-providers";

export default async function CoverLetterPage() {
  const [savedKeys, preferences] = await Promise.all([getApiKeys(), getTaskPreferences()]);
  const connectedProviders = savedKeys.map((k) => k.provider as Provider);

  return (
    <div className="p-8">
      <PageHeader
        title="Cover Letters"
        description="AI-generated cover letters tailored to each role"
      >
        <ProviderSelector
          task="cover-letter"
          current={preferences["cover-letter"]}
          connectedProviders={connectedProviders}
        />
      </PageHeader>
      <ComingSoon
        icon={FileText}
        title="Cover Letter Generator"
        description="Generate a compelling, personalised cover letter for any role in seconds — written in your voice, adapted to the specific job and company."
        features={[
          "Learns your writing style from examples you provide",
          "Adapts tone and content to each company's culture",
          "Highlights your most relevant experience per role",
          "Optimised to increase callback rate",
          "Export to PDF, Word, or copy to clipboard",
        ]}
      />
    </div>
  );
}
