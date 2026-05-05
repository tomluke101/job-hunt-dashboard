"use client";

// Multi-Master list. Renders one MasterCard per saved Master, plus an
// "Add new Master" CTA at the bottom that opens the wizard pre-loaded for
// new-Master mode. New users (no Masters yet) see an empty-state CTA.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Wand2, Loader2, AlertCircle } from "lucide-react";
import {
  saveMaster,
  generateMasterProfile,
  type MasterProfile,
} from "@/app/actions/cv-tailoring";
import MasterCard from "./MasterCard";
import ProfileBuilderWizard, { type WizardAnswers } from "./ProfileBuilderWizard";

interface Props {
  initial: MasterProfile[];
}

export default function MastersListSection({ initial }: Props) {
  const router = useRouter();
  // Drive the list directly from props. Each MasterCard calls onChange after
  // a mutation; we propagate via router.refresh() and the parent server
  // component re-renders with fresh data. No local list state, no sync bugs.
  const masters: MasterProfile[] = initial;
  const [isAddingBlank, startAddBlank] = useTransition();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    router.refresh();
  }

  function handleAddBlank() {
    setError(null);
    startAddBlank(async () => {
      const r = await saveMaster({
        name: `Master ${masters.length + 1}`,
        summary: "Type or paste your Profile here, or click Generate to draft from your FactBase.",
        source: "manual",
        isDefault: masters.length === 0,
      });
      if (r.error) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  async function handleWizardSubmit(answers: WizardAnswers): Promise<{ ok: boolean; error?: string }> {
    setError(null);
    try {
      const result = await generateMasterProfile({ wizardContext: answers });
      if (result.error) {
        return { ok: false, error: result.error };
      }
      if (!result.summary) {
        return { ok: false, error: "Generation returned no Profile." };
      }
      // Suggest a name from the wizard context (job title or stage), user can rename.
      const suggestedName =
        answers.jobTitle ||
        answers.lastJobTitle ||
        answers.freelanceDiscipline ||
        answers.degreeSubject ||
        `Master ${masters.length + 1}`;
      const r = await saveMaster({
        name: suggestedName,
        summary: result.summary,
        source: "generated",
        isDefault: masters.length === 0,
      });
      if (r.error) return { ok: false, error: r.error };
      router.refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Failed to build Master." };
    }
  }

  if (masters.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/50 p-6 text-center space-y-3">
          <div className="text-sm font-semibold text-slate-900">
            No Master Profiles yet
          </div>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            A Master Profile is your canonical pitch — used as the foundation
            for every CV you tailor. Save one for each role family you apply to
            (e.g. one for supply chain, one for property surveying).
          </p>
          <div className="flex items-center justify-center gap-2 flex-wrap pt-1">
            <button
              onClick={() => setWizardOpen(true)}
              disabled={isAddingBlank}
              className="text-xs font-semibold inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-40"
            >
              <Wand2 size={13} /> Build with help
            </button>
            <button
              onClick={handleAddBlank}
              disabled={isAddingBlank}
              className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40"
            >
              {isAddingBlank ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> Adding…
                </>
              ) : (
                <>
                  <Plus size={12} /> Start blank
                </>
              )}
            </button>
          </div>
        </div>
        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 flex items-start gap-1.5">
            <AlertCircle size={11} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {wizardOpen && (
          <ProfileBuilderWizard
            onClose={() => setWizardOpen(false)}
            onSubmit={handleWizardSubmit}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500 leading-relaxed">
        Your saved Master Profiles. The default is used as the base for every
        CV unless you pick a different one. Add more for different role
        families (e.g. a separate Master for property surveying, finance, etc.).
      </p>

      <div className="space-y-3">
        {masters.map((m) => (
          <MasterCard key={m.id} master={m} onChange={refresh} />
        ))}
      </div>

      <div className="flex items-center gap-2 flex-wrap pt-2">
        <button
          onClick={() => setWizardOpen(true)}
          disabled={isAddingBlank}
          className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-40"
        >
          <Wand2 size={12} /> Build a new Master with help
        </button>
        <button
          onClick={handleAddBlank}
          disabled={isAddingBlank}
          className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40"
        >
          {isAddingBlank ? (
            <>
              <Loader2 size={12} className="animate-spin" /> Adding…
            </>
          ) : (
            <>
              <Plus size={12} /> Add a blank Master
            </>
          )}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 flex items-start gap-1.5">
          <AlertCircle size={11} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {wizardOpen && (
        <ProfileBuilderWizard
          onClose={() => setWizardOpen(false)}
          onSubmit={handleWizardSubmit}
        />
      )}
    </div>
  );
}
