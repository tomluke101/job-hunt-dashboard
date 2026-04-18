"use client";

import { useState, useTransition } from "react";
import { saveApiKey, deleteApiKey, type ApiKey } from "@/app/actions/api-keys";
import type { Provider } from "@/lib/ai-providers";
import { Check, Eye, EyeOff, Trash2, ExternalLink, X } from "lucide-react";

interface ProviderConfig {
  id: Provider;
  name: string;
  description: string;
  bestFor: string[];
  tier: "best" | "balanced" | "budget";
  docsUrl: string;
  keyPrefix: string;
  models: string[];
}

const providers: ProviderConfig[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    description: "Best-in-class writing quality. Recommended for cover letters, CV tailoring, and nuanced tasks.",
    bestFor: ["Cover letters", "CV tailoring", "Complex reasoning"],
    tier: "best",
    docsUrl: "https://console.anthropic.com/settings/keys",
    keyPrefix: "sk-ant-",
    models: ["Claude Haiku (fast & cheap)", "Claude Sonnet (recommended)", "Claude Opus (most powerful)"],
  },
  {
    id: "openai",
    name: "OpenAI (GPT-4o)",
    description: "Most widely used. Excellent all-rounder with strong writing and reasoning capabilities.",
    bestFor: ["All tasks", "Job search ranking", "Summaries"],
    tier: "best",
    docsUrl: "https://platform.openai.com/api-keys",
    keyPrefix: "sk-",
    models: ["GPT-4o mini (fast & cheap)", "GPT-4o (recommended)"],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    description: "Fast and very affordable. Free tier available via Google AI Studio. Good for high-volume tasks.",
    bestFor: ["Job searching", "Summarisation", "Free usage"],
    tier: "balanced",
    docsUrl: "https://aistudio.google.com/app/apikey",
    keyPrefix: "AIza",
    models: ["Gemini 1.5 Flash (free tier available)", "Gemini 1.5 Pro"],
  },
  {
    id: "mistral",
    name: "Mistral AI",
    description: "European AI — strong privacy guarantees and GDPR compliance. Competitive pricing with solid quality.",
    bestFor: ["EU users", "Privacy-conscious users", "Cost-effective writing"],
    tier: "balanced",
    docsUrl: "https://console.mistral.ai/api-keys",
    keyPrefix: "",
    models: ["Mistral Small (cheapest)", "Mistral Large (best quality)"],
  },
  {
    id: "groq",
    name: "Groq (Llama 3.3)",
    description: "Runs open-source models at extremely fast speeds. Generous free tier — great for trying the platform.",
    bestFor: ["Free usage", "Fast responses", "Budget users"],
    tier: "budget",
    docsUrl: "https://console.groq.com/keys",
    keyPrefix: "gsk_",
    models: ["Llama 3.3 70B (free tier available)"],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    description: "AI with real-time web search. Used for finding contacts, company research, and live salary data.",
    bestFor: ["Contact finding", "Company research", "Live job market data"],
    tier: "balanced",
    docsUrl: "https://www.perplexity.ai/settings/api",
    keyPrefix: "pplx-",
    models: ["Sonar (fast, cheap)", "Sonar Pro (best research quality)"],
  },
];

const tierConfig = {
  best:     { label: "Best Quality",  color: "bg-blue-50 text-blue-700 border-blue-200" },
  balanced: { label: "Balanced",      color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  budget:   { label: "Free / Budget", color: "bg-slate-100 text-slate-600 border-slate-200" },
};

interface Props {
  savedKeys: ApiKey[];
}

export default function ApiKeyManager({ savedKeys }: Props) {
  const [keys, setKeys] = useState<ApiKey[]>(savedKeys);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<Provider | null>(null);

  const savedProviders = new Set(keys.map((k) => k.provider));

  function startEdit(provider: Provider) {
    setEditing(provider);
    setInputValue("");
    setShowKey(false);
    setError(null);
  }

  function handleSave(provider: Provider) {
    const key = inputValue.trim();
    if (!key) return;
    setError(null);

    startTransition(async () => {
      try {
        await saveApiKey(provider, key);
        const preview = `${key.slice(0, 8)}...${key.slice(-4)}`;
        setKeys((prev) => {
          const without = prev.filter((k) => k.provider !== provider);
          return [...without, { provider, key_preview: preview, created_at: new Date().toISOString() }];
        });
        setEditing(null);
        setInputValue("");
        setSuccess(provider);
        setTimeout(() => setSuccess(null), 3000);
      } catch {
        setError("Failed to save key. Please try again.");
      }
    });
  }

  function handleDelete(provider: Provider) {
    startTransition(async () => {
      try {
        await deleteApiKey(provider);
        setKeys((prev) => prev.filter((k) => k.provider !== provider));
      } catch {
        setError("Failed to remove key.");
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
        <p className="font-medium mb-1">Your keys are stored securely</p>
        <p className="text-amber-700 text-xs">API keys are encrypted in our database and never exposed client-side. You only need to connect the providers you want to use.</p>
      </div>

      {providers.map((p) => {
        const saved = keys.find((k) => k.provider === p.id);
        const isEditing = editing === p.id;
        const justSaved = success === p.id;
        const tier = tierConfig[p.tier];

        return (
          <div key={p.id} className={`bg-white rounded-xl border shadow-sm overflow-hidden ${saved ? "border-slate-200" : "border-slate-200"}`}>
            <div className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-slate-900 text-sm">{p.name}</h3>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${tier.color}`}>
                      {tier.label}
                    </span>
                    {saved && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 flex items-center gap-1">
                        <Check size={10} /> Connected
                      </span>
                    )}
                    {justSaved && (
                      <span className="text-xs text-green-600 font-medium">Saved!</span>
                    )}
                  </div>
                  <p className="text-slate-500 text-xs mb-2">{p.description}</p>
                  <div className="flex flex-wrap gap-1 mb-2">
                    {p.bestFor.map((b) => (
                      <span key={b} className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{b}</span>
                    ))}
                  </div>
                  <div className="text-xs text-slate-400">
                    Models: {p.models.join(" · ")}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={p.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-slate-400 hover:text-blue-500 transition-colors"
                    title="Get API key"
                  >
                    <ExternalLink size={14} />
                  </a>
                  {saved ? (
                    <>
                      <span className="text-xs text-slate-400 font-mono">{saved.key_preview}</span>
                      <button
                        onClick={() => startEdit(p.id)}
                        className="text-xs text-slate-500 hover:text-blue-600 font-medium px-2 py-1 rounded hover:bg-blue-50 transition-colors"
                      >
                        Replace
                      </button>
                      <button
                        onClick={() => handleDelete(p.id)}
                        disabled={isPending}
                        className="text-slate-400 hover:text-red-500 transition-colors disabled:opacity-40"
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => startEdit(p.id)}
                      className="text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium px-3 py-1.5 rounded-lg transition-colors"
                    >
                      Connect
                    </button>
                  )}
                </div>
              </div>

              {isEditing && (
                <div className="mt-4 pt-4 border-t border-slate-100">
                  <label className="text-xs font-medium text-slate-500 block mb-1.5">
                    Paste your {p.name} API key
                    {p.keyPrefix && <span className="ml-1 text-slate-400">(starts with <span className="font-mono">{p.keyPrefix}</span>)</span>}
                  </label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input
                        type={showKey ? "text" : "password"}
                        placeholder={`${p.keyPrefix}...`}
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleSave(p.id)}
                        className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 pr-9 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 font-mono"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey((v) => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                      >
                        {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    <button
                      onClick={() => handleSave(p.id)}
                      disabled={!inputValue.trim() || isPending}
                      className="text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-medium px-4 py-2 rounded-lg transition-colors"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setEditing(null); setInputValue(""); setError(null); }}
                      className="text-slate-400 hover:text-slate-600"
                    >
                      <X size={16} />
                    </button>
                  </div>
                  {error && <p className="text-red-500 text-xs mt-1.5">{error}</p>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
