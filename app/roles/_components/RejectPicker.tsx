"use client";

import { useState } from "react";
import { X } from "lucide-react";

interface Props {
  onPick: (reason: string) => void;
  onClose: () => void;
}

const OPTIONS = [
  "Bad fit — not the right role",
  "Bad location or commute",
  "Salary too low",
  "Company I don't want to work at",
  "Too senior / not senior enough",
  "Wrong working model (office/remote/hybrid)",
  "Industry I don't want",
  "Travel too heavy",
  "Something else",
];

export default function RejectPicker({ onPick, onClose }: Props) {
  const [custom, setCustom] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  function submit() {
    const reason = picked === "Something else" ? custom.trim() : picked;
    if (!reason) return;
    onPick(reason);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl bg-white shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Why not this job?</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              We'll use this to sharpen your next results. One click.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {OPTIONS.map((o) => (
            <button
              key={o}
              onClick={() => setPicked(o)}
              className={`w-full text-left text-sm px-3 py-2 rounded-md border transition-colors ${
                picked === o
                  ? "bg-blue-50 border-blue-200 text-slate-900"
                  : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
              }`}
            >
              {o}
            </button>
          ))}
        </div>
        {picked === "Something else" && (
          <input
            autoFocus
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Type your reason"
            className="mt-3 w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="text-sm text-slate-600 hover:text-slate-800 px-3 py-1.5"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!picked || (picked === "Something else" && !custom.trim())}
            className="text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-md px-3 py-1.5 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}
