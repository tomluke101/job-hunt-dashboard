import { Users } from "lucide-react";
import PageHeader from "../_components/PageHeader";
import ComingSoon from "../_components/ComingSoon";
import ProviderSelector from "../_components/ProviderSelector";
import { getApiKeys } from "@/app/actions/api-keys";
import { getTaskPreferences } from "@/app/actions/preferences";
import type { Provider } from "@/lib/ai-providers";

export default async function ContactsPage() {
  const [savedKeys, preferences] = await Promise.all([getApiKeys(), getTaskPreferences()]);
  const connectedProviders = savedKeys.map((k) => k.provider as Provider);

  return (
    <div className="p-8">
      <PageHeader
        title="Contacts"
        description="Find the right people and craft messages that open doors"
      >
        <ProviderSelector
          task="contact-research"
          current={preferences["contact-research"]}
          connectedProviders={connectedProviders}
        />
      </PageHeader>
      <ComingSoon
        icon={Users}
        title="Contact Finder & Outreach Drafter"
        description="Identify hiring managers, recruiters, and relevant employees at target companies — then generate personalised outreach messages that actually get replies."
        features={[
          "Searches LinkedIn, company sites, and public data for contacts",
          "Finds hiring managers, team leads, and relevant employees",
          "Drafts personalised LinkedIn messages and cold emails",
          "Falls back to template outreach if no contact found",
          "Tracks who you've messaged and their responses",
        ]}
      />
    </div>
  );
}
