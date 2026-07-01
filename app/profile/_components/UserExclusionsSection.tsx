"use client";

// Global exclusions list — phrases the user never wants in ANY Profile,
// regardless of which Master is in use. Stored on user_profile, applied
// everywhere a Profile is generated.

import { useState, useTransition } from "react";
import { Plus, X, Loader2, Check, AlertCircle, ShieldOff, Save } from "lucide-react";
import { setUserExclusions } from "@/app/actions/cv-tailoring";

interface Props {
  initial: string[];
}

export default function UserExclusionsSection({ initial }: Props) {
  const [items, setItems] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");
  const [isSaving, startSave] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsMigration, setNeedsMigration] = useState(false);

  const isDirty = JSON.stringify(items) !== JSON.stringify(initial);

  function handleAdd() {
    const t = draft.trim();
    if (!t) return;
    if (items.some((i) => i.toLowerCase() === t.toLowerCase())) {
      setDraft("");
      return;
    }
    if (items.length >= 50) {
      setError("Cap reached — 50 exclusions max. Remove one before adding another.");
      return;
    }
    setItems([...items, t]);
    setDraft("");
    setError(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    }
  }

  function handleRemove(index: number) {
    setItems(items.filter((_, i) => i !== index));
  }

  function handleSave() {
    setError(null);
    setSaved(false);
    setNeedsMigration(false);
    startSave(async () => {
      const r = await setUserExclusions(items);
      if (r.error) {
        setError(r.error);
        setNeedsMigration(!!r.needsMigration);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500 leading-relaxed">
        Phrases the AI must NEVER include in your Profile, no matter how
        relevant the JD looks. Applies globally across every Master and
        every tailored CV. Useful when the AI keeps reaching for something
        you&apos;ve deliberately left out — a tool you don&apos;t want
        highlighted, an old role, a specific claim you&apos;ve moved on from.
      </p>

      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-rose-200 bg-rose-50 text-rose-900"
            >
              <ShieldOff size={10} />
              <span>{item}</span>
              <button
                onClick={() => handleRemove(i)}
                disabled={isSaving}
                className="text-rose-400 hover:text-rose-700 disabled:opacity-40"
                aria-label={`Remove ${item}`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isSaving}
          placeholder="e.g. a tool name you don't want surfaced, an old role, or a specific claim you've moved on from"
          className="flex-1 text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 disabled:opacity-40 placeholder-slate-300"
        />
        <button
          onClick={handleAdd}
          disabled={isSaving || !draft.trim()}
          className="text-xs font-medium inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-40"
        >
          <Plus size={11} /> Add
        </button>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-[11px] text-slate-400">
          {items.length} exclusion{items.length === 1 ? "" : "s"}
          {items.length >= 50 && " (cap reached)"}
        </div>
        <button
          onClick={handleSave}
          disabled={isSaving || !isDirty}
          className={`text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40 ${
            saved
              ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
              : "bg-slate-900 text-white hover:bg-slate-800"
          }`}
        >
          {isSaving ? (
            <>
              <Loader2 size={12} className="animate-spin" /> Saving…
            </>
          ) : saved ? (
            <>
              <Check size={12} /> Saved
            </>
          ) : (
            <>
              <Save size={12} /> Save exclusions
            </>
          )}
        </button>
      </div>

      {error && (
        <div
          className={`rounded-lg border p-3 text-xs flex items-start gap-1.5 ${
            needsMigration
              ? "border-amber-200 bg-amber-50 text-amber-900"
              : "border-rose-200 bg-rose-50 text-rose-900"
          }`}
        >
          <AlertCircle size={11} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
