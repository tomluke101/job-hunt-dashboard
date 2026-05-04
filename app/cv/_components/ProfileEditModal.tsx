"use client";

import { useState, useTransition } from "react";
import { Loader2, X, Check, AlertCircle, Pencil } from "lucide-react";
import { saveMasterProfile } from "@/app/actions/cv-tailoring";

interface Props {
  // Current Profile text being edited (the tailored CV's current summary).
  initialValue: string;
  // Called when the user saves changes for THIS CV only.
  onSave: (newSummary: string) => void;
  // Called when the modal is closed without saving.
  onClose: () => void;
}

export default function ProfileEditModal({ initialValue, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(initialValue);
  const [isSavingMaster, startSaveMaster] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedMasterFlash, setSavedMasterFlash] = useState(false);

  const wordCount = draft.trim().split(/\s+/).filter(Boolean).length;
  const isDirty = draft !== initialValue;

  function handleSaveForCV() {
    if (!draft.trim()) return;
    onSave(draft.trim());
    onClose();
  }

  function handleSaveAsMaster() {
    if (!draft.trim()) return;
    setError(null);
    startSaveMaster(async () => {
      const r = await saveMasterProfile({ summary: draft.trim(), source: "edited" });
      if (r.error) {
        setError(r.error);
        return;
      }
      setSavedMasterFlash(true);
      onSave(draft.trim());
      setTimeout(() => onClose(), 800);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4 shrink-0">
          <div>
            <h2 className="font-bold text-slate-900 text-lg inline-flex items-center gap-2">
              <Pencil size={16} className="text-slate-600" /> Edit Profile
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Edit for this CV, or save as your new Master to use as the default for every future CV.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isSavingMaster}
            className="text-slate-400 hover:text-slate-700 p-1 disabled:opacity-30"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={isSavingMaster}
            rows={8}
            className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed font-serif disabled:opacity-50"
          />
          <div className="text-xs text-slate-400">{wordCount} words</div>
          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 flex items-start gap-1.5">
              <AlertCircle size={11} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50 px-6 py-4 rounded-b-2xl shrink-0">
          <button
            onClick={onClose}
            disabled={isSavingMaster}
            className="text-sm font-medium text-slate-500 hover:text-slate-900 px-3 py-2 disabled:opacity-40"
          >
            Cancel
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveAsMaster}
              disabled={isSavingMaster || !draft.trim() || !isDirty}
              className={`text-sm font-medium inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border transition-colors ${
                savedMasterFlash
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
              } disabled:opacity-40`}
            >
              {isSavingMaster ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Saving…
                </>
              ) : savedMasterFlash ? (
                <>
                  <Check size={13} /> Saved as Master
                </>
              ) : (
                <>Save as new Master</>
              )}
            </button>
            <button
              onClick={handleSaveForCV}
              disabled={isSavingMaster || !draft.trim() || !isDirty}
              className="text-sm font-semibold inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-40"
            >
              <Check size={13} /> Use for this CV only
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
