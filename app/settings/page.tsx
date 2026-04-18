import { getApiKeys } from "@/app/actions/api-keys";
import PageHeader from "@/app/_components/PageHeader";
import ApiKeyManager from "./_components/ApiKeyManager";

export default async function SettingsPage() {
  const savedKeys = await getApiKeys();

  return (
    <div className="p-8 max-w-3xl">
      <PageHeader
        title="Settings"
        description="Manage your AI API keys and preferences"
      />
      <ApiKeyManager savedKeys={savedKeys} />
    </div>
  );
}
