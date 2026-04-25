"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Plus, Trash2, Check, Pencil, ChevronRight, RotateCcw, Briefcase } from "lucide-react";
import { addSkill, updateSkill, deleteSkill, polishSkillText, type UserSkill, type UserEmployer } from "@/app/actions/profile";

function EmployerChips({
  employers,
  selectedIds,
  onToggle,
}: {
  employers: UserEmployer[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}) {
  if (employers.length === 0) {
    return (
      <p className="text-xs text-slate-400 italic">Add a role in Work History above to tag skills to it.</p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {employers.map((emp) => {
        const selected = selectedIds.includes(emp.id);
        return (
          <button
            key={emp.id}
            type="button"
            onClick={() => onToggle(emp.id)}
            className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full border transition-colors ${
              selected
                ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
                : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50 hover:text-slate-700"
            }`}
          >
            {selected && <Check size={10} />}
            {emp.company_name}
          </button>
        );
      })}
    </div>
  );
}

function SkillItem({ skill, employers, onDelete }: { skill: UserSkill; employers: UserEmployer[]; onDelete: (id: string) => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(skill.raw_text);
  const [polished, setPolished] = useState(skill.polished_text ?? "");
  const [employerIds, setEmployerIds] = useState<string[]>(skill.employer_ids ?? []);
  const [polishing, startPolishing] = useTransition();
  const [saving, startSaving] = useTransition();

  function handlePolish() {
    startPolishing(async () => {
      try {
        const result = await polishSkillText(raw);
        setPolished(result);
      } catch {
        // No key connected — leave polished empty
      }
    });
  }

  function toggleEmployer(id: string) {
    setEmployerIds((ids) => ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]);
  }

  function handleSave() {
    startSaving(async () => {
      await updateSkill(skill.id, raw, polished || undefined, employerIds);
      setEditing(false);
      router.refresh();
    });
  }

  const display = skill.polished_text || skill.raw_text;
  const skillEmployers = (skill.employer_ids ?? [])
    .map((id) => employers.find((e) => e.id === id))
    .filter((e): e is UserEmployer => !!e);

  if (editing) {
    return (
      <div className="bg-white border border-blue-200 rounded-xl p-4 shadow-sm">
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-slate-500 block mb-1.5">Your words</label>
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={2}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none"
              placeholder="Describe what you did — in your own words, don't worry about sounding impressive"
            />
          </div>

          {polished && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-semibold text-emerald-700 flex items-center gap-1"><Sparkles size={11} /> AI-polished version</p>
                <button
                  onClick={() => setPolished("")}
                  className="flex items-center gap-1 text-xs font-medium text-emerald-700 hover:text-emerald-900 transition-colors"
                  title="Remove the polished version and use your own words"
                >
                  <RotateCcw size={11} /> Clear polished
                </button>
              </div>
              <textarea
                value={polished}
                onChange={(e) => setPolished(e.target.value)}
                rows={2}
                className="w-full text-sm text-emerald-900 bg-white/70 border border-emerald-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400 resize-none leading-relaxed"
              />
              <p className="text-xs text-emerald-700/70 mt-1.5">Edit to fix anything the AI got wrong, or clear it to fall back to your own words.</p>
            </div>
          )}

          <div>
            <label className="text-xs font-semibold text-slate-500 block mb-1.5 flex items-center gap-1">
              <Briefcase size={11} /> Where did you do this?
              <span className="text-slate-400 font-normal normal-case ml-1">optional — leave blank for general / innate skills</span>
            </label>
            <EmployerChips employers={employers} selectedIds={employerIds} onToggle={toggleEmployer} />
          </div>

          <div className="flex items-center gap-2">
            <button onClick={handlePolish} disabled={polishing || !raw.trim()} className="flex items-center gap-1.5 text-xs font-medium text-purple-600 hover:text-purple-700 px-2.5 py-1.5 rounded-lg border border-purple-200 hover:bg-purple-50 disabled:opacity-40 transition-colors">
              <Sparkles size={12} /> {polishing ? "Polishing…" : polished ? "Re-polish" : "Polish with AI"}
            </button>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => setEditing(false)} className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={saving || !raw.trim()} className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-medium px-3 py-1.5 rounded-lg transition-colors">
                <Check size={13} /> {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 bg-white border border-slate-200 rounded-xl p-4 group">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-800 leading-relaxed">{display}</p>
        <div className="flex items-center gap-2 flex-wrap mt-1.5">
          {skill.polished_text && skill.polished_text !== skill.raw_text && (
            <p className="text-xs text-slate-400 flex items-center gap-1"><Sparkles size={10} className="text-purple-400" /> AI-polished</p>
          )}
          {skillEmployers.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {skillEmployers.map((emp) => (
                <span key={emp.id} className="text-xs font-medium text-slate-500 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded-full">
                  {emp.company_name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button onClick={() => setEditing(true)} className="text-slate-400 hover:text-blue-500 transition-colors p-1"><Pencil size={13} /></button>
        <button onClick={() => onDelete(skill.id)} className="text-slate-400 hover:text-red-500 transition-colors p-1"><Trash2 size={13} /></button>
      </div>
    </div>
  );
}

function AddSkillForm({ employers, onDone }: { employers: UserEmployer[]; onDone: () => void }) {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [polished, setPolished] = useState("");
  const [employerIds, setEmployerIds] = useState<string[]>([]);
  const [polishing, startPolishing] = useTransition();
  const [saving, startSaving] = useTransition();

  function handlePolish() {
    startPolishing(async () => {
      try {
        const result = await polishSkillText(raw);
        setPolished(result);
      } catch {
        // Silently fail — save raw only
      }
    });
  }

  function toggleEmployer(id: string) {
    setEmployerIds((ids) => ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]);
  }

  function handleSave() {
    if (!raw.trim()) return;
    startSaving(async () => {
      await addSkill(raw.trim(), polished || undefined, employerIds);
      router.refresh();
      onDone();
    });
  }

  return (
    <div className="bg-white border-2 border-blue-200 rounded-xl p-5 shadow-sm">
      <div className="space-y-3">
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1.5">
            Describe your experience or achievement
          </label>
          <textarea
            autoFocus
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={3}
            placeholder="Write it how you'd tell a friend — don't worry about sounding impressive. E.g. &quot;I helped set up a new system for tracking customer complaints that saved a lot of back and forth&quot;"
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed placeholder-slate-400"
          />
        </div>

        {polished && (
          <div className="bg-gradient-to-r from-purple-50 to-blue-50 border border-purple-200 rounded-xl p-4">
            <div className="flex items-center gap-1.5 mb-2">
              <Sparkles size={13} className="text-purple-500" />
              <p className="text-xs font-semibold text-purple-700">AI-polished version</p>
            </div>
            <p className="text-sm text-slate-800 leading-relaxed">{polished}</p>
            <p className="text-xs text-slate-400 mt-2">Both versions are saved — the AI picks the best framing for each role.</p>
          </div>
        )}

        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1.5 flex items-center gap-1">
            <Briefcase size={11} /> Where did you do this?
            <span className="text-slate-400 font-normal normal-case ml-1">optional — leave blank for general / innate skills</span>
          </label>
          <EmployerChips employers={employers} selectedIds={employerIds} onToggle={toggleEmployer} />
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handlePolish}
            disabled={polishing || !raw.trim()}
            className="flex items-center gap-1.5 text-sm font-medium text-purple-600 hover:text-purple-700 px-3 py-1.5 rounded-lg border border-purple-200 hover:bg-purple-50 disabled:opacity-40 transition-colors"
          >
            <Sparkles size={13} />
            {polishing ? "Polishing…" : polished ? "Re-polish" : "Polish with AI"}
          </button>

          <div className="ml-auto flex items-center gap-2">
            <button onClick={onDone} className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !raw.trim()}
              className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-medium px-4 py-1.5 rounded-lg transition-colors"
            >
              <Check size={13} /> {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SkillsManager({ initial, employers }: { initial: UserSkill[]; employers: UserEmployer[] }) {
  const router = useRouter();
  const [skills, setSkills] = useState<UserSkill[]>(initial);
  const [showAdd, setShowAdd] = useState(false);
  const [deleting, startDeleting] = useTransition();

  function handleDelete(id: string) {
    startDeleting(async () => {
      await deleteSkill(id);
      router.refresh();
    });
  }

  return (
    <div>
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-100 rounded-xl p-4 mb-5">
        <div className="flex items-start gap-3">
          <Sparkles size={18} className="text-blue-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-blue-900">This is the most important section</p>
            <p className="text-sm text-blue-700 mt-0.5 leading-relaxed">
              The AI can only write a brilliant cover letter if it knows your real story.
              Add achievements, projects, and experiences that aren't on your CV — even if you can't find the right words yet.
              We'll help you turn them into something impressive.
              <span className="font-semibold"> The more you add, the better your cover letters become.</span>
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-3 mb-4">
        {skills.length === 0 && !showAdd && (
          <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-xl">
            <p className="text-sm text-slate-500 font-medium mb-1">No experiences added yet</p>
            <p className="text-xs text-slate-400">Think of a time you made something better, led something, or solved a problem</p>
          </div>
        )}
        {initial.map((skill) => (
          <SkillItem key={skill.id} skill={skill} employers={employers} onDelete={handleDelete} />
        ))}
        {showAdd && <AddSkillForm employers={employers} onDone={() => setShowAdd(false)} />}
      </div>

      {!showAdd && (
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 text-sm text-blue-600 font-medium hover:text-blue-700 transition-colors"
        >
          <Plus size={15} /> Add an experience or achievement
        </button>
      )}

      {initial.length > 0 && (
        <p className="text-xs text-slate-400 mt-4 flex items-center gap-1">
          <ChevronRight size={12} />
          {initial.length} experience{initial.length !== 1 ? "s" : ""} saved — the AI will draw on all of these when writing cover letters
        </p>
      )}
    </div>
  );
}
