"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Plus, Trash2, X, Check, Pencil, ChevronRight } from "lucide-react";
import { addSkill, updateSkill, deleteSkill, polishSkillText, type UserSkill } from "@/app/actions/profile";

function SkillItem({ skill, onDelete }: { skill: UserSkill; onDelete: (id: string) => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(skill.raw_text);
  const [polished, setPolished] = useState(skill.polished_text ?? "");
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

  function handleSave() {
    startSaving(async () => {
      await updateSkill(skill.id, raw, polished || undefined);
      setEditing(false);
      router.refresh();
    });
  }

  const display = skill.polished_text || skill.raw_text;

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
              <p className="text-xs font-semibold text-emerald-700 mb-1 flex items-center gap-1"><Sparkles size={11} /> AI-polished version</p>
              <p className="text-sm text-emerald-800">{polished}</p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button onClick={handlePolish} disabled={polishing || !raw.trim()} className="flex items-center gap-1.5 text-xs font-medium text-purple-600 hover:text-purple-700 px-2.5 py-1.5 rounded-lg border border-purple-200 hover:bg-purple-50 disabled:opacity-40 transition-colors">
              <Sparkles size={12} /> {polishing ? "Polishing…" : "Polish with AI"}
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
        {skill.polished_text && skill.polished_text !== skill.raw_text && (
          <p className="text-xs text-slate-400 mt-1 flex items-center gap-1"><Sparkles size={10} className="text-purple-400" /> AI-polished from your original</p>
        )}
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button onClick={() => setEditing(true)} className="text-slate-400 hover:text-blue-500 transition-colors p-1"><Pencil size={13} /></button>
        <button onClick={() => onDelete(skill.id)} className="text-slate-400 hover:text-red-500 transition-colors p-1"><Trash2 size={13} /></button>
      </div>
    </div>
  );
}

function AddSkillForm({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [polished, setPolished] = useState("");
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

  function handleSave() {
    if (!raw.trim()) return;
    startSaving(async () => {
      await addSkill(raw.trim(), polished || undefined);
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

export default function SkillsManager({ initial }: { initial: UserSkill[] }) {
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
          <SkillItem key={skill.id} skill={skill} onDelete={handleDelete} />
        ))}
        {showAdd && <AddSkillForm onDone={() => setShowAdd(false)} />}
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
