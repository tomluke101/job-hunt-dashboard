"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { saveCoverLetterPrefs, type CoverLetterPrefs } from "@/app/actions/profile";

const SALUTATIONS = [
  "Dear Hiring Manager",
  "Dear Hiring Team",
  "Dear Sir or Madam",
  "To Whom It May Concern",
];

export default function CoverLetterPrefsForm({ initial }: { initial: CoverLetterPrefs }) {
  const [prefs, setPrefs] = useState<CoverLetterPrefs>({
    salutation: initial.salutation ?? "Dear Hiring Manager",
    include_header: initial.include_header ?? true,
    always_mention: initial.always_mention ?? "",
    never_do: initial.never_do ?? "",
    extra_tone_notes: initial.extra_tone_notes ?? "",
    enable_skill_discovery: initial.enable_skill_discovery ?? true,
  });
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const isCustomSalutation = !!prefs.salutation && !SALUTATIONS.includes(prefs.salutation);
  const [customActive, setCustomActive] = useState(isCustomSalutation);
  const [customSalutation, setCustomSalutation] = useState(isCustomSalutation ? prefs.salutation! : "");

  function selectSalutation(s: string) {
    setCustomActive(false);
    setPrefs((p) => ({ ...p, salutation: s }));
  }

  function activateCustomSalutation() {
    setCustomActive(true);
    setPrefs((p) => ({ ...p, salutation: customSalutation }));
  }

  function handleCustomSalutationChange(val: string) {
    setCustomSalutation(val);
    setPrefs((p) => ({ ...p, salutation: val }));
  }

  function handleSave() {
    startTransition(async () => {
      await saveCoverLetterPrefs(prefs);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    });
  }

  return (
    <div className="space-y-6">

      {/* Salutation */}
      <div>
        <label className="text-xs font-semibold text-slate-500 block mb-2">Opening Greeting</label>
        <div className="flex flex-wrap gap-2 mb-2">
          {SALUTATIONS.map((s) => (
            <button
              key={s}
              onClick={() => selectSalutation(s)}
              className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${
                !customActive && prefs.salutation === s
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
              }`}
            >
              {s}
            </button>
          ))}
          <button
            onClick={activateCustomSalutation}
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
            placeholder='e.g. "Dear [Name]," or "Good morning,"'
            value={customSalutation}
            onChange={(e) => handleCustomSalutationChange(e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
          />
        )}
      </div>

      {/* Contact header */}
      <div>
        <label className="text-xs font-semibold text-slate-500 block mb-2">Contact Header</label>
        <label className="flex items-start gap-3 cursor-pointer group">
          <div className="relative mt-0.5">
            <input
              type="checkbox"
              checked={prefs.include_header ?? true}
              onChange={(e) => setPrefs((p) => ({ ...p, include_header: e.target.checked }))}
              className="sr-only"
            />
            <div
              className={`w-9 h-5 rounded-full transition-colors ${prefs.include_header ? "bg-blue-600" : "bg-slate-200"}`}
              onClick={() => setPrefs((p) => ({ ...p, include_header: !p.include_header }))}
            >
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${prefs.include_header ? "translate-x-4" : "translate-x-0.5"}`} />
            </div>
          </div>
          <div>
            <p className="text-sm font-medium text-slate-800">Show contact block at the top of every letter</p>
            <p className="text-xs text-slate-400 mt-0.5">Adds your name, location, phone, email, and headline above the greeting — standard UK cover letter format</p>
          </div>
        </label>
      </div>

      {/* Always mention */}
      <div>
        <label className="text-xs font-semibold text-slate-500 block mb-1.5">
          Always include <span className="font-normal text-slate-400">— things the AI should get across in every letter</span>
        </label>
        <textarea
          value={prefs.always_mention ?? ""}
          onChange={(e) => setPrefs((p) => ({ ...p, always_mention: e.target.value }))}
          placeholder={"e.g. \"Always mention I'm based in Birmingham — no relocation needed\" or \"I want to come across as someone who is analytical but also personable\" or \"I'm actively studying for APC — mention this\""}
          rows={3}
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed placeholder-slate-300"
        />
      </div>

      {/* Never do */}
      <div>
        <label className="text-xs font-semibold text-slate-500 block mb-1.5">
          Never include <span className="font-normal text-slate-400">— things the AI should always avoid</span>
        </label>
        <textarea
          value={prefs.never_do ?? ""}
          onChange={(e) => setPrefs((p) => ({ ...p, never_do: e.target.value }))}
          placeholder={"e.g. \"Never mention my gap year\" or \"Don't reference my first job at McDonald's\" or \"Avoid mentioning salary expectations\""}
          rows={3}
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed placeholder-slate-300"
        />
      </div>

      {/* Tone notes */}
      <div>
        <label className="text-xs font-semibold text-slate-500 block mb-1.5">
          Tone notes <span className="font-normal text-slate-400">— how you want to come across beyond formal/balanced/conversational</span>
        </label>
        <textarea
          value={prefs.extra_tone_notes ?? ""}
          onChange={(e) => setPrefs((p) => ({ ...p, extra_tone_notes: e.target.value }))}
          placeholder={"e.g. \"Confident but not arrogant — I don't want to oversell\" or \"I want to sound like a senior professional, not a graduate\" or \"Punchy and direct — cut anything that sounds corporate\""}
          rows={3}
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed placeholder-slate-300"
        />
      </div>

      {/* Skill discovery toggle */}
      <div>
        <label className="text-xs font-semibold text-slate-500 block mb-2">Skills Discovery</label>
        <label className="flex items-start gap-3 cursor-pointer">
          <div className="relative mt-0.5 shrink-0">
            <div
              className={`w-9 h-5 rounded-full transition-colors ${prefs.enable_skill_discovery !== false ? "bg-blue-600" : "bg-slate-200"}`}
              onClick={() => setPrefs((p) => ({ ...p, enable_skill_discovery: !(p.enable_skill_discovery !== false) }))}
            >
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${prefs.enable_skill_discovery !== false ? "translate-x-4" : "translate-x-0.5"}`} />
            </div>
          </div>
          <div>
            <p className="text-sm font-medium text-slate-800">Spot gaps after each generation</p>
            <p className="text-xs text-slate-400 mt-0.5">After your cover letter is generated, the AI will check the JD for skills or experience you haven't mentioned — and ask if you have them. Anything you add can be saved to your profile automatically.</p>
          </div>
        </label>
      </div>

      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-slate-400">These preferences are applied automatically to every cover letter you generate.</p>
        <button
          onClick={handleSave}
          disabled={isPending}
          className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors"
        >
          {saved ? <><Check size={14} /> Saved</> : isPending ? "Saving…" : "Save Preferences"}
        </button>
      </div>
    </div>
  );
}
