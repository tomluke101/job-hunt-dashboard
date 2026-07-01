// Normalisation + heuristic quality scoring for pulled jobs.
// Cheap discriminating signals — designed so scores actually SPREAD across
// [10, 95] instead of clustering at the ceiling. LLM-driven axes
// (match-to-user, career-fit) run downstream in the pipeline.

import { createHash } from "crypto";
import type { RawJob, WorkingModel } from "./types";
import { htmlToText } from "./html-to-text";

export interface NormalisedJob extends RawJob {
  working_model: WorkingModel;
  hybrid_days_office: number | null;
  salary_listed: boolean;
  dedupe_hash: string;
  quality_score: number;
  quality_reasons: string[];
}

export function normalise(raw: RawJob): NormalisedJob {
  // Belt-and-braces: if a source already gave plain text, tidyText leaves it;
  // if it forgot to strip HTML, htmlToText handles it. Look at BOTH the text
  // and html fields in case one is cleaner than the other.
  const jd_text = normaliseJd(raw.jd_text, raw.jd_html);
  const wm = detectWorkingModel(jd_text, raw.location_raw);
  const salary_listed = isSalaryListed(raw);
  const q = scoreQuality({ raw, jd_text, wm: wm.model, salary_listed });
  return {
    ...raw,
    jd_text,
    working_model: wm.model,
    hybrid_days_office: wm.days,
    salary_listed,
    dedupe_hash: dedupeHash(raw.company, raw.title, jd_text),
    quality_score: q.score,
    quality_reasons: q.reasons,
  };
}

function normaliseJd(text: string | null | undefined, html: string | null | undefined): string {
  const looksHtml = (s: string | null | undefined): boolean =>
    !!s && (/<\/?(p|br|div|li|ul|ol|h[1-6])\b/i.test(s) || /&#?\w+;/.test(s));
  if (looksHtml(html)) return htmlToText(html!);
  if (looksHtml(text)) return htmlToText(text!);
  return (text ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Working-model detection. Multi-pass so specific signals beat loose mentions.
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

function isSalaryListed(raw: RawJob): boolean {
  const min = raw.salary_min ?? 0;
  const max = raw.salary_max ?? 0;
  // Reed sometimes returns placeholder £1 or £0 when salary is undisclosed.
  if (min > 0 && min < 1000 && max === min) return false;
  return !!(min || max);
}

function dedupeHash(company: string, title: string, jd: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  const key = `${norm(company)}|${norm(title)}|${norm(jd).slice(0, 500)}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

const BUZZWORDS = [
  "fast[- ]paced",
  "dynamic",
  "rockstar",
  "ninja",
  "guru",
  "wear(?:s|ing)? many hats",
  "we[' ]?re a passionate",
  "we[' ]?re a family",
  "work hard, play hard",
];

const NAMED_TOOLS = [
  "sap", "sql", "tableau", "power bi", "excel", "python", "salesforce", "oracle", "workday",
  "jira", "confluence", "aws", "azure", "gcp", "docker", "kubernetes", "terraform",
  "solidworks", "autocad", "erp", "mrp", "figma", "photoshop", "illustrator", "hubspot",
  "netsuite", "quickbooks", "xero", "sage", "google analytics", "r studio", "matlab",
];

// 0-100 quality score. Spread designed to land ~30-85 with signal.
function scoreQuality({
  raw,
  jd_text,
  wm,
  salary_listed,
}: {
  raw: RawJob;
  jd_text: string;
  wm: WorkingModel;
  salary_listed: boolean;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let s = 40;

  // Salary
  if (salary_listed) {
    s += 8;
    reasons.push("salary listed +8");
  } else {
    s -= 6;
    reasons.push("salary hidden -6");
  }

  // JD length as signal of detail (with diminishing returns).
  const len = jd_text.length;
  if (len < 300) {
    s -= 25;
    reasons.push("very short JD -25");
  } else if (len < 600) {
    s -= 2;
    reasons.push("short JD -2");
  } else if (len < 1500) {
    s += 8;
    reasons.push("substantive JD +8");
  } else {
    s += 15;
    reasons.push("detailed JD +15");
  }

  // Recency
  if (raw.posted_at) {
    const ageDays = (Date.now() - new Date(raw.posted_at).getTime()) / 86400000;
    if (ageDays < 3) { s += 10; reasons.push("very fresh +10"); }
    else if (ageDays < 7) { s += 6; reasons.push("this week +6"); }
    else if (ageDays < 14) { s += 2; }
    else if (ageDays > 30) { s -= 12; reasons.push("stale -12"); }
  }

  // Structure signals: bullet lists = well-organised JD.
  const bulletCount = (jd_text.match(/^\s*[-•]\s/gm) ?? []).length;
  if (bulletCount >= 5) { s += 8; reasons.push("well-structured +8"); }
  else if (bulletCount >= 2) { s += 3; }

  // Named-tool mentions = specificity signal.
  const jdLower = jd_text.toLowerCase();
  const toolHits = NAMED_TOOLS.filter((t) => new RegExp(`\\b${t}\\b`).test(jdLower)).length;
  const toolBonus = Math.min(12, toolHits * 2);
  if (toolBonus > 0) { s += toolBonus; reasons.push(`specific tools +${toolBonus}`); }

  // Working-model detected
  if (wm !== "unknown") { s += 4; reasons.push("working model detected +4"); }
  else { s -= 3; reasons.push("working model unclear -3"); }

  // Buzzword penalty
  const buzzHits = BUZZWORDS.filter((b) => new RegExp(`\\b${b}\\b`, "i").test(jd_text)).length;
  const buzzPenalty = Math.min(15, buzzHits * 4);
  if (buzzPenalty > 0) { s -= buzzPenalty; reasons.push(`buzzwords -${buzzPenalty}`); }

  // Low-effort signals: repeated exclamation, ALL-CAPS shouting, keyword-stuffed title.
  if (/!!/.test(jd_text) || /!\s*!\s*!/.test(jd_text)) { s -= 6; reasons.push("shouty JD -6"); }
  const capsWords = (jd_text.match(/\b[A-Z]{5,}\b/g) ?? []).length;
  if (capsWords >= 6) { s -= 6; reasons.push("caps-heavy -6"); }
  if (raw.title && raw.title.length > 40 && / and |\/|,/.test(raw.title)) {
    s -= 5;
    reasons.push("stuffed title -5");
  }

  // Entity residue = poor extraction OR poor source formatting.
  if (/&#?\w+;/.test(jd_text)) { s -= 8; reasons.push("bad formatting -8"); }

  const score = Math.max(0, Math.min(100, Math.round(s)));
  return { score, reasons };
}
