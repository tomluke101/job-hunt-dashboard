"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { saveProfile, type UserProfile } from "@/app/actions/profile";

const SIGN_OFFS = ["Kind regards", "Best regards", "Yours sincerely", "Many thanks", "Best wishes"];

const TONES = [
  { value: "formal",         label: "Formal",         description: "Professional and structured — suits finance, law, large corporates" },
  { value: "balanced",       label: "Balanced",        description: "Confident and clear — works for most roles and industries" },
  { value: "conversational", label: "Conversational",  description: "Warm and direct — suits startups, creative, and tech roles" },
] as const;

const FIELDS: { key: keyof UserProfile; label: string; placeholder: string; type?: string }[] = [
  { key: "full_name",    label: "Full Name",             placeholder: "e.g. Tom Luke" },
  { key: "headline",     label: "Professional Headline", placeholder: "e.g. Senior Product Manager" },
  { key: "email",        label: "Email",                 placeholder: "e.g. tom@email.com",       type: "email" },
  { key: "phone",        label: "Phone",                 placeholder: "e.g. +44 7700 900000" },
  { key: "linkedin_url", label: "LinkedIn URL",          placeholder: "e.g. linkedin.com/in/tomluke", type: "url" },
  { key: "location",     label: "Location",              placeholder: "e.g. London, UK" },
];

export default function ConstantsForm({ initial }: { initial: UserProfile }) {
  const [form, setForm] = useState<UserProfile>(initial);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isPreset = SIGN_OFFS.includes(form.sign_off ?? "");
  const [customActive, setCustomActive] = useState(() => !!(form.sign_off && !SIGN_OFFS.includes(form.sign_off)));
  const [customValue, setCustomValue]   = useState(() => (form.sign_off && !SIGN_OFFS.includes(form.sign_off)) ? form.sign_off : "");

  function selectPreset(s: string) {
    setCustomActive(false);
    setForm((f) => ({ ...f, sign_off: s }));
  }

  function activateCustom() {
    setCustomActive(true);
    setForm((f) => ({ ...f, sign_off: customValue || "" }));
  }

  function handleCustomChange(val: string) {
    setCustomValue(val);
    setForm((f) => ({ ...f, sign_off: val }));
  }

  function handleSave() {
    setSaveError(null);
    startTransition(async () => {
      const result = await saveProfile(form);
      if (result.error) {
        setSaveError(result.error);
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        {FIELDS.map(({ key, label, placeholder, type = "text" }) => (
          <div key={key}>
            <label className="text-xs font-semibold text-slate-500 block mb-1.5">{label}</label>
            <input
              type={type}
              placeholder={placeholder}
              value={(form[key] as string) ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
            />
          </div>
        ))}
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-500 block mb-2">Sign-off</label>
        <div className="flex flex-wrap gap-2">
          {SIGN_OFFS.map((s) => (
            <button
              key={s}
              onClick={() => selectPreset(s)}
              className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${
                !customActive && form.sign_off === s
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
              }`}
            >
              {s}
            </button>
          ))}
          <button
            onClick={activateCustom}
            className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${
              customActive
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
            }`}
          >
            Custom…
          </button>
        </div>

        {customActive && (
          <input
            type="text"
            autoFocus
            placeholder="e.g. Warm regards, Cheers, All the best"
            value={customValue}
            onChange={(e) => handleCustomChange(e.target.value)}
            className="mt-2.5 w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
          />
        )}
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-500 block mb-2">Writing Tone</label>
        <div className="grid grid-cols-3 gap-3">
          {TONES.map((t) => (
            <button
              key={t.value}
              onClick={() => setForm((f) => ({ ...f, tone: t.value }))}
              className={`text-left p-3 rounded-xl border transition-all ${
                form.tone === t.value
                  ? "bg-blue-50 border-blue-300 shadow-sm"
                  : "bg-white border-slate-200 hover:border-slate-300"
              }`}
            >
              <p className={`text-sm font-semibold mb-0.5 ${form.tone === t.value ? "text-blue-700" : "text-slate-900"}`}>{t.label}</p>
              <p className="text-xs text-slate-500 leading-snug">{t.description}</p>
            </button>
          ))}
        </div>
      </div>

      {saveError && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          Save failed: {saveError}
        </p>
      )}

      <div className="flex items-center justify-between pt-2">
        <p className="text-xs text-slate-400">These details appear at the top and bottom of every cover letter automatically.</p>
        <button
          onClick={handleSave}
          disabled={isPending}
          className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors"
        >
          {saved ? <><Check size={14} /> Saved</> : isPending ? "Saving…" : "Save Details"}
        </button>
      </div>
    </div>
  );
}
