"use client";

import { useTransition } from "react";
import { Zap } from "lucide-react";
import { PROVIDERS, TASK_DEFAULTS, TASK_LABELS, type Provider, type Task } from "@/lib/ai-providers";
import { setTaskPreference } from "@/app/actions/preferences";

const tierBadge: Record<string, string> = {
  best:     "bg-blue-50 text-blue-600 border-blue-200",
  balanced: "bg-emerald-50 text-emerald-600 border-emerald-200",
  budget:   "bg-slate-100 text-slate-500 border-slate-200",
};

interface Props {
  task: Task;
  current: Provider | "auto" | undefined;
  connectedProviders: Provider[];
}

export default function ProviderSelector({ task, current, connectedProviders }: Props) {
  const [isPending, startTransition] = useTransition();
  const connected = new Set(connectedProviders);
  const taskInfo = TASK_LABELS[task];

  // The recommended provider is the first connected one in the default order
  const recommended = TASK_DEFAULTS[task].find((p) => connected.has(p));

  const effective = current === "auto" || !current ? "auto" : current;

  function handleChange(value: string) {
    startTransition(async () => {
      await setTaskPreference(task, value as Provider | "auto");
    });
  }

  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-slate-500 font-medium whitespace-nowrap">AI Provider:</label>
      <div className="relative">
        <select
          value={effective}
          onChange={(e) => handleChange(e.target.value)}
          disabled={isPending || connectedProviders.length === 0}
          className="text-sm border border-slate-200 rounded-lg pl-3 pr-8 py-1.5 bg-white text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 disabled:opacity-50 appearance-none cursor-pointer"
        >
          <option value="auto">
            Auto{recommended ? ` (${PROVIDERS[recommended].shortName})` : " — no key connected"}
          </option>
          {(Object.keys(PROVIDERS) as Provider[]).map((p) => {
            const meta = PROVIDERS[p];
            const isConnected = connected.has(p);
            return (
              <option key={p} value={p} disabled={!isConnected}>
                {meta.shortName}{!isConnected ? " — not connected" : ""}
              </option>
            );
          })}
        </select>
        <Zap size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
      </div>

      {/* Show active provider pill */}
      {effective !== "auto" && connected.has(effective as Provider) && (
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${tierBadge[PROVIDERS[effective as Provider].tier]}`}>
          {PROVIDERS[effective as Provider].tagline}
        </span>
      )}
      {effective === "auto" && recommended && (
        <span className="text-xs text-slate-400">
          Using <span className="font-medium text-slate-600">{PROVIDERS[recommended].shortName}</span>
        </span>
      )}
      {connectedProviders.length === 0 && (
        <span className="text-xs text-amber-600 font-medium">Connect a key in Settings to use AI features</span>
      )}
    </div>
  );
}
