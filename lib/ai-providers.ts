export type Provider = "anthropic" | "openai" | "gemini" | "mistral" | "groq" | "perplexity";

export type Task =
  | "cover-letter"
  | "cv-tailor"
  | "job-summary"
  | "contact-research"
  | "job-match";

export interface ProviderMeta {
  name: string;
  shortName: string;
  tagline: string;
  model: string;
  baseURL?: string;
  tier: "best" | "balanced" | "budget";
}

export const PROVIDERS: Record<Provider, ProviderMeta> = {
  anthropic: {
    name: "Claude (Anthropic)",
    shortName: "Claude",
    tagline: "Best for writing & nuanced tasks",
    model: "claude-sonnet-4-6",
    tier: "best",
  },
  openai: {
    name: "GPT-4o (OpenAI)",
    shortName: "GPT-4o",
    tagline: "Reliable all-rounder",
    model: "gpt-4o",
    tier: "best",
  },
  gemini: {
    name: "Gemini (Google)",
    shortName: "Gemini",
    tagline: "Long context & research",
    model: "gemini-1.5-pro",
    tier: "balanced",
  },
  mistral: {
    name: "Mistral",
    shortName: "Mistral",
    tagline: "Fast & EU-based",
    model: "mistral-large-latest",
    tier: "balanced",
  },
  groq: {
    name: "Groq (Llama 3.3)",
    shortName: "Groq",
    tagline: "Fastest inference, free tier",
    model: "llama-3.3-70b-versatile",
    baseURL: "https://api.groq.com/openai/v1",
    tier: "budget",
  },
  perplexity: {
    name: "Perplexity",
    shortName: "Perplexity",
    tagline: "Web search built-in",
    model: "llama-3.1-sonar-large-128k-online",
    baseURL: "https://api.perplexity.ai",
    tier: "balanced",
  },
};

// Priority order: first connected provider in the list wins
export const TASK_DEFAULTS: Record<Task, Provider[]> = {
  "cover-letter":     ["anthropic", "openai", "gemini", "mistral", "groq"],
  "cv-tailor":        ["anthropic", "openai", "gemini", "mistral", "groq"],
  "job-summary":      ["openai", "anthropic", "gemini", "groq", "mistral"],
  "contact-research": ["perplexity", "openai", "anthropic", "gemini", "mistral"],
  "job-match":        ["gemini", "openai", "anthropic", "mistral", "groq"],
};

export const TASK_LABELS: Record<Task, { label: string; description: string }> = {
  "cover-letter":     { label: "Cover Letter Generation", description: "Writing tailored cover letters for each role" },
  "cv-tailor":        { label: "CV Tailoring",            description: "Adapting your CV to match a specific job description" },
  "job-summary":      { label: "Job Summarisation",       description: "Summarising and scoring job listings" },
  "contact-research": { label: "Contact Research",        description: "Finding hiring managers and contacts at companies" },
  "job-match":        { label: "Job Matching",            description: "Ranking and matching roles against your profile" },
};

export function resolveProvider(
  task: Task,
  userPreference: Provider | "auto" | undefined,
  connectedProviders: Set<Provider>
): Provider | null {
  if (userPreference && userPreference !== "auto" && connectedProviders.has(userPreference)) {
    return userPreference;
  }
  for (const p of TASK_DEFAULTS[task]) {
    if (connectedProviders.has(p)) return p;
  }
  return null;
}
