"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Plus, Trash2, X, Check } from "lucide-react";
import { addWritingExample, deleteWritingExample, type WritingExample } from "@/app/actions/profile";

export default function WritingExamples({ initial }: { initial: WritingExample[] }) {
  const router = useRouter();
  const [showAdd, setShowAdd] = useState(false);
  const [label, setLabel] = useState("");
  const [content, setContent] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [deleting, startDeleting] = useTransition();

  function handleSave() {
    if (!content.trim()) return;
    startSaving(async () => {
      await addWritingExample(content.trim(), label.trim() || undefined);
      setShowAdd(false);
      setLabel("");
      setContent("");
      router.refresh();
    });
  }

  function handleDelete(id: string) {
    startDeleting(async () => {
      await deleteWritingExample(id);
      router.refresh();
    });
  }

  return (
    <div>
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-5 text-sm text-slate-600 leading-relaxed">
        Upload a cover letter you've written before that you're happy with. The AI will study your tone, sentence structure, and style — and write future cover letters that sound like <span className="font-semibold text-slate-900">you</span>, not like a robot.
      </div>

      <div className="space-y-3 mb-4">
        {initial.length === 0 && !showAdd && (
          <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-xl">
            <FileText size={22} className="text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-500 font-medium">No examples yet</p>
            <p className="text-xs text-slate-400 mt-0.5">Optional — but makes a noticeable difference to quality</p>
          </div>
        )}

        {initial.map((ex) => (
          <div key={ex.id}>
            <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl p-4 group">
              <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center shrink-0">
                <FileText size={14} className="text-slate-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-900">{ex.label || "Writing example"}</p>
                <p className="text-xs text-slate-400">{ex.content.split(/\s+/).length} words</p>
              </div>
              <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => setPreviewId(previewId === ex.id ? null : ex.id)} className="text-xs text-slate-500 hover:text-blue-600 font-medium px-2 py-1 rounded hover:bg-blue-50 transition-colors">
                  {previewId === ex.id ? "Hide" : "Preview"}
                </button>
                <button onClick={() => handleDelete(ex.id)} disabled={deleting} className="text-slate-400 hover:text-red-500 transition-colors p-1">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            {previewId === ex.id && (
              <div className="bg-slate-50 border border-t-0 border-slate-200 rounded-b-xl px-4 py-3 -mt-1">
                <pre className="text-xs text-slate-600 whitespace-pre-wrap font-sans leading-relaxed max-h-40 overflow-y-auto">{ex.content.slice(0, 800)}{ex.content.length > 800 ? "\n\n[…]" : ""}</pre>
              </div>
            )}
          </div>
        ))}

        {showAdd && (
          <div className="bg-white border-2 border-blue-200 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-sm font-semibold text-slate-900">Add a writing example</h4>
              <button onClick={() => { setShowAdd(false); setLabel(""); setContent(""); }} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-500 block mb-1.5">Label (optional)</label>
                <input
                  type="text"
                  placeholder='e.g. "Cover letter for Monzo, 2024"'
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 block mb-1.5">Paste your cover letter</label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={8}
                  placeholder="Paste a cover letter you've written. The AI will learn your tone and style from this."
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed"
                />
                <p className="text-xs text-slate-400 mt-1">{content.split(/\s+/).filter(Boolean).length} words</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setShowAdd(false); setLabel(""); setContent(""); }} className="text-sm text-slate-500 hover:text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-100 transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={saving || !content.trim()} className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-medium px-4 py-2 rounded-lg transition-colors">
                <Check size={13} /> {saving ? "Saving…" : "Save Example"}
              </button>
            </div>
          </div>
        )}
      </div>

      {!showAdd && (
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 text-sm text-blue-600 font-medium hover:text-blue-700 transition-colors">
          <Plus size={15} /> Add a writing example
        </button>
      )}
    </div>
  );
}
