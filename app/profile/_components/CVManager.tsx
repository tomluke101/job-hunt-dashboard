"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { FileText, Star, Trash2, Plus, X, Upload } from "lucide-react";
import { saveCV, setDefaultCV, deleteCV, type UserCV } from "@/app/actions/profile";

export default function CVManager({ initial }: { initial: UserCV[] }) {
  const router = useRouter();
  const [cvs, setCvs] = useState<UserCV[]>(initial);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [setAsDefault, setSetAsDefault] = useState(cvs.length === 0);
  const [isPending, startTransition] = useTransition();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!name) setName(file.name.replace(/\.[^.]+$/, ""));
    const reader = new FileReader();
    reader.onload = (ev) => setContent(ev.target?.result as string ?? "");
    reader.readAsText(file);
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleSave() {
    if (!name.trim() || !content.trim()) return;
    startTransition(async () => {
      await saveCV(name.trim(), content.trim(), setAsDefault || cvs.length === 0);
      setShowAdd(false);
      setName("");
      setContent("");
      router.refresh();
    });
  }

  function handleSetDefault(id: string) {
    startTransition(async () => {
      await setDefaultCV(id);
      router.refresh();
    });
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      await deleteCV(id);
      router.refresh();
    });
  }

  return (
    <div>
      <div className="space-y-3 mb-4">
        {cvs.length === 0 && !showAdd && (
          <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-xl">
            <FileText size={24} className="text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-500 font-medium">No CV uploaded yet</p>
            <p className="text-xs text-slate-400 mt-0.5">Your CV is the foundation of every cover letter</p>
          </div>
        )}

        {cvs.map((cv) => (
          <div key={cv.id} className={`flex items-center gap-3 p-4 rounded-xl border ${cv.is_default ? "border-blue-200 bg-blue-50/40" : "border-slate-200 bg-white"}`}>
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${cv.is_default ? "bg-blue-100" : "bg-slate-100"}`}>
              <FileText size={16} className={cv.is_default ? "text-blue-600" : "text-slate-500"} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-slate-900 truncate">{cv.name}</p>
                {cv.is_default && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200 shrink-0">Default</span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">{cv.content.split(/\s+/).length} words</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={() => setPreviewId(previewId === cv.id ? null : cv.id)} className="text-xs text-slate-500 hover:text-blue-600 font-medium px-2 py-1 rounded hover:bg-blue-50 transition-colors">
                {previewId === cv.id ? "Hide" : "Preview"}
              </button>
              {!cv.is_default && (
                <button onClick={() => handleSetDefault(cv.id)} disabled={isPending} className="text-xs text-slate-500 hover:text-amber-600 font-medium px-2 py-1 rounded hover:bg-amber-50 transition-colors flex items-center gap-1">
                  <Star size={11} /> Set default
                </button>
              )}
              <button onClick={() => handleDelete(cv.id)} disabled={isPending} className="text-slate-400 hover:text-red-500 transition-colors p-1">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}

        {cvs.map((cv) => previewId === cv.id && (
          <div key={`preview-${cv.id}`} className="bg-slate-50 border border-slate-200 rounded-xl p-4">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Preview — {cv.name}</p>
            <pre className="text-xs text-slate-600 whitespace-pre-wrap font-sans leading-relaxed max-h-48 overflow-y-auto">{cv.content.slice(0, 1000)}{cv.content.length > 1000 ? "\n\n[…]" : ""}</pre>
          </div>
        ))}
      </div>

      {showAdd ? (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-sm font-semibold text-slate-900">Add a CV</h4>
            <button onClick={() => { setShowAdd(false); setName(""); setContent(""); }} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold text-slate-500 block mb-1.5">CV Name</label>
              <input
                type="text"
                placeholder='e.g. "Product Manager CV" or "Main CV"'
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-slate-500">CV Content</label>
                <label className="flex items-center gap-1 text-xs text-blue-600 font-medium cursor-pointer hover:text-blue-700">
                  <Upload size={12} /> Upload .txt file
                  <input ref={fileRef} type="file" accept=".txt,.text" className="hidden" onChange={handleFile} />
                </label>
              </div>
              <textarea
                placeholder="Paste your CV text here — copy from Word, Google Docs, or any editor. Include everything: experience, education, skills."
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={8}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none font-mono"
              />
              <p className="text-xs text-slate-400 mt-1">{content.split(/\s+/).filter(Boolean).length} words</p>
            </div>

            {cvs.length > 0 && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={setAsDefault} onChange={(e) => setSetAsDefault(e.target.checked)} className="rounded border-slate-300 text-blue-600" />
                <span className="text-sm text-slate-600">Set as default CV</span>
              </label>
            )}
          </div>

          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => { setShowAdd(false); setName(""); setContent(""); }} className="text-sm text-slate-500 hover:text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-100 transition-colors">Cancel</button>
            <button onClick={handleSave} disabled={isPending || !name.trim() || !content.trim()} className="text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-medium px-4 py-2 rounded-lg transition-colors">
              {isPending ? "Saving…" : "Save CV"}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => { setShowAdd(true); setSetAsDefault(cvs.length === 0); }}
          className="flex items-center gap-2 text-sm text-blue-600 font-medium hover:text-blue-700 transition-colors"
        >
          <Plus size={15} /> Add {cvs.length > 0 ? "another" : "a"} CV
        </button>
      )}
    </div>
  );
}
