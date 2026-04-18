import { ScrollText } from "lucide-react";
import PageHeader from "../_components/PageHeader";
import ComingSoon from "../_components/ComingSoon";
import ProviderSelector from "../_components/ProviderSelector";
import { getApiKeys } from "@/app/actions/api-keys";
import { getTaskPreferences } from "@/app/actions/preferences";
import type { Provider } from "@/lib/ai-providers";

export default async function CVPage() {
  const [savedKeys, preferences] = await Promise.all([getApiKeys(), getTaskPreferences()]);
  const connectedProviders = savedKeys.map((k) => k.provider as Provider);

  return (
    <div className="p-8">
      <PageHeader
        title="CV Builder"
        description="Adapt your CV to every role automatically"
      >
        <ProviderSelector
          task="cv-tailor"
          current={preferences["cv-tailor"]}
          connectedProviders={connectedProviders}
        />
      </PageHeader>
      <ComingSoon
        icon={ScrollText}
        title="Adaptive CV Generator"
        description="Your base CV, intelligently reordered and reworded for each application — surfacing the skills and experience that matter most for that specific role."
        features={[
          "Upload your master CV once",
          "AI reorders and rewrites sections to match each JD",
          "Keyword optimisation for ATS systems",
          "Preserves your authentic voice and facts",
          "Side-by-side diff view to see what changed and why",
        ]}
      />
    </div>
  );
}
