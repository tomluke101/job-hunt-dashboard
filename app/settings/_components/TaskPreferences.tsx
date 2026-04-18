"use client";

import { useTransition, useState } from "react";
import { Zap, Check } from "lucide-react";
import {
  PROVIDERS, TASK_DEFAULTS, TASK_LABELS,
  type Provider, type Task,
} from "@/lib/ai-providers";
import { setTaskPreference, type TaskPreferences } from "@/app/actions/preferences";
import type { ApiKey } from "@/app/actions/api-keys";

const tierBadge: Record<string, string> = {
  best:     "bg-blue-50 text-blue-600 border-blue-200",
  balanced: "bg-emerald-50 text-emerald-600 border-emerald-200",
  budget:   "bg-slate-100 text-slate-500 border-slate-200",
};

interface Props {
  savedKeys: ApiKey[];
  preferences: TaskPreferences;
}

const TASKS = Object.keys(TASK_LABELS) as Task[];

export default function TaskPreferences({ savedKeys, preferences: initialPrefs }: Props) {
  const [prefs, setPrefs] = useState<TaskPreferences>(initialPrefs);
  const [saved, setSaved] = useState<Task | null>(null);
  const [isPending, startTransition] = useTransition();

  const connectedSet = new Set(savedKeys.map((k) => k.provider));

  function handleChange(task: Task, value: string) {
    const provider = value as Provider | "auto";
    setPrefs((prev) => ({ ...prev, [task]: provider }));

    startTransition(async () => {
      await setTaskPreference(task, provider);
      setSaved(task);
      setTimeout(() => setSaved(null), 2000);
    });
  }

  const hasAnyKey = savedKeys.length > 0;

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-base font-semibold text-slate-900">Task Preferences</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Choose which AI model handles each task. <span className="font-medium">Auto</span> picks the best connected provider automatically.
        </p>
      </div>

      {!hasAnyKey && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800 mb-4">
          <p className="font-medium">No API keys connected yet</p>
          <p className="text-amber-700 text-xs mt-0.5">Connect at least one API key above to enable AI features.</p>
        </div>
      )}

      <div className="space-y-3">
        {TASKS.map((task) => {
          const { label, description } = TASK_LABELS[task];
          const current = prefs[task] ?? "auto";
          const recommended = TASK_DEFAULTS[task].find((p) => connectedSet.has(p));
          const justSaved = saved === task;

          return (
            <div key={task} className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="text-sm font-semibold text-slate-900">{label}</p>
                    {justSaved && (
                      <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                        <Check size={11} /> Saved
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">{description}</p>
                  {recommended && (
                    <p className="text-xs text-slate-400 mt-1">
                      Recommended: <span className="font-medium text-slate-600">{PROVIDERS[recommended].shortName}</span>
                      {" "}—{" "}{PROVIDERS[recommended].tagline}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {current !== "auto" && connectedSet.has(current as Provider) && (
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${tierBadge[PROVIDERS[current as Provider].tier]}`}>
                      {PROVIDERS[current as Provider].tier === "best" ? "Best Quality" : PROVIDERS[current as Provider].tier === "balanced" ? "Balanced" : "Free / Budget"}
                    </span>
                  )}
                  <div className="relative">
                    <select
                      value={current}
                      onChange={(e) => handleChange(task, e.target.value)}
                      disabled={isPending || !hasAnyKey}
                      className="text-sm border border-slate-200 rounded-lg pl-3 pr-8 py-1.5 bg-white text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 disabled:opacity-50 appearance-none cursor-pointer min-w-[160px]"
                    >
                      <option value="auto">
                        Auto{recommended ? ` (${PROVIDERS[recommended].shortName})` : ""}
                      </option>
                      <optgroup label="Connected">
                        {(Object.keys(PROVIDERS) as Provider[])
                          .filter((p) => connectedSet.has(p))
                          .map((p) => (
                            <option key={p} value={p}>{PROVIDERS[p].shortName}</option>
                          ))}
                      </optgroup>
                      {(Object.keys(PROVIDERS) as Provider[]).some((p) => !connectedSet.has(p)) && (
                        <optgroup label="Not connected">
                          {(Object.keys(PROVIDERS) as Provider[])
                            .filter((p) => !connectedSet.has(p))
                            .map((p) => (
                              <option key={p} value={p} disabled>{PROVIDERS[p].shortName}</option>
                            ))}
                        </optgroup>
                      )}
                    </select>
                    <Zap size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
