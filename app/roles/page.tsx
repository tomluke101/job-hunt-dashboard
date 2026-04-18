import { Search } from "lucide-react";
import PageHeader from "../_components/PageHeader";
import ComingSoon from "../_components/ComingSoon";
import ProviderSelector from "../_components/ProviderSelector";
import { getApiKeys } from "@/app/actions/api-keys";
import { getTaskPreferences } from "@/app/actions/preferences";
import type { Provider } from "@/lib/ai-providers";

export default async function RolesPage() {
  const [savedKeys, preferences] = await Promise.all([getApiKeys(), getTaskPreferences()]);
  const connectedProviders = savedKeys.map((k) => k.provider as Provider);

  return (
    <div className="p-8">
      <PageHeader
        title="Ideal Roles"
        description="Find roles that match your profile and goals"
      >
        <ProviderSelector
          task="job-match"
          current={preferences["job-match"]}
          connectedProviders={connectedProviders}
        />
      </PageHeader>
      <ComingSoon
        icon={Search}
        title="Role Discovery"
        description="Set your criteria once and we'll surface the best-matched roles from across the web, ranked by fit and filtered to your preferences."
        features={[
          "Define your target role types, seniority, and sector",
          "Set salary range, location, and remote preferences",
          "AI ranks roles by fit against your CV and goals",
          "Summarises each role: pros, cons, earnings, career path",
          "One-click to generate a tailored cover letter or CV",
        ]}
      />
    </div>
  );
}
