"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { FileText, Star, Trash2, Plus, X, Upload, Loader2, Maximize2 } from "lucide-react";
import { saveCV, setDefaultCV, deleteCV, type UserCV } from "@/app/actions/profile";
import { parseDocument } from "@/app/actions/parse-document";

export default function CVManager({ initial }: { initial: UserCV[] }) {
  const router = useRouter();
  const [cvs, setCvs] = useState<UserCV[]>(initial);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [setAsDefault, setSetAsDefault] = useState(cvs.length === 0);
  const [isPending, startTransition] = useTransition();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [fullScreenId, setFullScreenId] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;

    if (!name) setName(file.name.replace(/\.[^.]+$/, ""));
    setParseError(null);
    setParsing(true);

    try {
      const fd = new FormData();
      fd.append("file", file);
      const { text } = await parseDocument(fd);
      setContent(text);
    } catch (err: unknown) {
      setParseError(err instanceof Error ? err.message : "Failed to read file. Try pasting the text manually.");
    } finally {
      setParsing(false);
    }
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
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Preview — {cv.name}</p>
              <button
                onClick={() => setFullScreenId(cv.id)}
                className="text-xs text-slate-500 hover:text-blue-600 inline-flex items-center gap-1 font-medium px-2 py-0.5 rounded hover:bg-blue-50 transition-colors"
              >
                <Maximize2 size={11} /> Full view
              </button>
            </div>
            <pre className="text-sm text-slate-700 whitespace-pre-wrap font-sans leading-relaxed max-h-[480px] overflow-y-auto">{cv.content}</pre>
          </div>
        ))}

        {fullScreenId && (() => {
          const cv = cvs.find((c) => c.id === fullScreenId);
          if (!cv) return null;
          return (
            <div
              className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
              onClick={() => setFullScreenId(null)}
            >
              <div
                className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between p-5 border-b border-slate-200 shrink-0">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{cv.name}</p>
                    <p className="text-xs text-slate-400">{cv.content.split(/\s+/).filter(Boolean).length} words</p>
                  </div>
                  <button
                    onClick={() => setFullScreenId(null)}
                    className="text-slate-400 hover:text-slate-700 transition-colors p-1"
                    aria-label="Close"
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className="overflow-y-auto p-6 flex-1">
                  <pre className="text-sm text-slate-800 whitespace-pre-wrap font-sans leading-relaxed">{cv.content}</pre>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {showAdd ? (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-sm font-semibold text-slate-900">Add a CV</h4>
            <button onClick={() => { setShowAdd(false); setName(""); setContent(""); setParseError(null); }} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
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

            {/* Upload button */}
            <div>
              <label className="flex items-center justify-center gap-2 w-full border-2 border-dashed border-slate-200 hover:border-blue-300 hover:bg-blue-50/30 rounded-xl py-5 cursor-pointer transition-colors text-sm text-slate-500 hover:text-blue-600 font-medium">
                {parsing ? (
                  <><Loader2 size={16} className="animate-spin text-blue-500" /> Reading file…</>
                ) : (
                  <><Upload size={16} /> Upload PDF, Word (.docx) or plain text (.txt)</>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pdf,.docx,.doc,.txt,.text"
                  className="hidden"
                  onChange={handleFile}
                  disabled={parsing}
                />
              </label>
              {parseError && (
                <p className="text-xs text-red-500 mt-1.5">{parseError}</p>
              )}
            </div>

            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-slate-100" />
              <span className="text-xs text-slate-400 font-medium">or paste manually</span>
              <div className="flex-1 h-px bg-slate-100" />
            </div>

            <div>
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
            <button onClick={() => { setShowAdd(false); setName(""); setContent(""); setParseError(null); }} className="text-sm text-slate-500 hover:text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-100 transition-colors">Cancel</button>
            <button onClick={handleSave} disabled={isPending || !name.trim() || !content.trim() || parsing} className="text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-medium px-4 py-2 rounded-lg transition-colors">
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
