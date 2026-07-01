// Normalisation + heuristic quality scoring for pulled jobs.
// Every axis here is CHEAP. LLM-driven axes (match-to-user, career-fit) run
// downstream in the pipeline, not here.

import { createHash } from "crypto";
import type { RawJob, WorkingModel } from "./types";

export interface NormalisedJob extends RawJob {
  working_model: WorkingModel;
  hybrid_days_office: number | null;
  salary_listed: boolean;
  dedupe_hash: string;
  quality_score: number;
}

export function normalise(raw: RawJob): NormalisedJob {
  const wm = detectWorkingModel(raw.jd_text, raw.location_raw);
  const salary_listed = !!(raw.salary_min || raw.salary_max);
  const jd_text = cleanJd(raw.jd_text);
  return {
    ...raw,
    jd_text,
    working_model: wm.model,
    hybrid_days_office: wm.days,
    salary_listed,
    dedupe_hash: dedupeHash(raw.company, raw.title, jd_text),
    quality_score: scoreQuality(raw, wm.model, salary_listed, jd_text),
  };
}

function cleanJd(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Working-model detection from JD + location text.
// Multi-pass: explicit-fully-remote > numeric hybrid-days > loose hybrid > loose remote > office > unknown.
function detectWorkingModel(jd: string, location: string | null): { model: WorkingModel; days: number | null } {
  const text = `${jd} ${location ?? ""}`.toLowerCase();
  if (/\bfully remote\b|\bremote[- ]first\b|\bremote[- ]only\b|\bwork from anywhere\b|\b100%\s*remote\b/.test(text)) {
    return { model: "remote", days: 0 };
  }
  const hybridDays = text.match(/(\d)\s*days?\s*(?:per\s*week\s*)?(?:in\s*(?:the\s*)?office|on[- ]?site|in[- ]?person)/);
  if (hybridDays) return { model: "hybrid", days: parseInt(hybridDays[1], 10) };
  if (/\bhybrid\b/.test(text)) return { model: "hybrid", days: null };
  if (/\bremote\b|\bwork from home\b/.test(text)) return { model: "remote", days: 0 };
  if (/\bon[- ]?site\b|\boffice[- ]based\b|\bin[- ]?office\b|\bin[- ]?person\b/.test(text)) return { model: "office", days: 5 };
  return { model: "unknown", days: null };
}

// Dedupe key: same company + same title + same first 500 chars of JD.
// Cheap enough to catch same-day reposts + agency-vs-direct pairs of the same role.
function dedupeHash(company: string, title: string, jd: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  const key = `${norm(company)}|${norm(title)}|${norm(jd).slice(0, 500)}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// Cheap 0-100 quality signal — pre-LLM heuristic.
// Salary listed + fresh + specific + working-model-detected all lift; short-JD + old post drop.
function scoreQuality(raw: RawJob, wm: WorkingModel, salary_listed: boolean, jd: string): number {
  let s = 50;
  if (salary_listed) s += 15;
  if (jd.length > 800) s += 10;
  else if (jd.length > 500) s += 5;
  else if (jd.length < 200) s -= 20;
  if (wm !== "unknown") s += 5;
  if (raw.posted_at) {
    const ageDays = (Date.now() - new Date(raw.posted_at).getTime()) / 86400000;
    if (ageDays < 7) s += 10;
    else if (ageDays > 30) s -= 15;
  }
  if (/^apply now$|^click apply$/i.test(jd.trim())) s -= 30;
  return Math.max(0, Math.min(100, Math.round(s)));
}
