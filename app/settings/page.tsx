import { getApiKeys } from "@/app/actions/api-keys";
import { getTaskPreferences } from "@/app/actions/preferences";
import PageHeader from "@/app/_components/PageHeader";
import ApiKeyManager from "./_components/ApiKeyManager";
import TaskPreferences from "./_components/TaskPreferences";

export default async function SettingsPage() {
  const [savedKeys, preferences] = await Promise.all([
    getApiKeys(),
    getTaskPreferences(),
  ]);

  return (
    <div className="p-8 max-w-3xl">
      <PageHeader
        title="Settings"
        description="Manage your AI providers and task preferences"
      />

      <div className="space-y-12">
        <section>
          <div className="mb-5">
            <h2 className="text-base font-semibold text-slate-900">API Keys</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Connect the AI providers you want to use. You only need one — we recommend Claude or GPT-4o to start.
            </p>
          </div>
          <ApiKeyManager savedKeys={savedKeys} />
        </section>

        <div className="border-t border-slate-200" />

        <section>
          <TaskPreferences savedKeys={savedKeys} preferences={preferences} />
        </section>
      </div>
    </div>
  );
}
