// Brand-level company-size lookup via Haiku 4.5.
//
// This replaces the earlier employee-COUNT lookup (`employee-count-llm.ts`),
// which asked the wrong question and declined on 30 of the 31 companies it ran
// against. Two things were wrong with it:
//
//   1. It asked for a PRECISE HEADCOUNT. "How many UK staff did ALDI STORES
//      LIMITED report in its most recent accounts?" is a question about an
//      accounting disclosure, and the model rightly answers "low confidence" —
//      it cannot recall a filed figure. But the size filter never needed a
//      number, only a BAND. "Is Aldi 1-20 or 5000+?" is trivially answerable.
//
//   2. It asked about the COMPANIES HOUSE LEGAL ENTITY. The legal entity is
//      often a subsidiary or holding shell that the model has never heard of
//      ("GXO LOGISTICS DRINKFLOW HOLDINGS LIMITED"), and worse, it is sometimes
//      the WRONG entity entirely — CH matched "Amazon Flex" to a 2-employee
//      shell, which bucketed Amazon as a `startup`. The jobseeker is filtering
//      on the employer BRAND they'd actually work for, so that is what we ask
//      about.
//
// Measured on the live company set: high-confidence answers on 11/15 previously
// unknown companies, with the three genuinely obscure firms correctly declining
// to `low` (so they stay `unknown` rather than receive a fabricated band).
//
// The high-confidence gate is the safety property: an unrecognised company
// yields no band, never a guess. Wrong data is worse than no data.
//
// Cost ~$0.0006 per fresh company, cached forever in `company_enrichment`.

import Anthropic from "@anthropic-ai/sdk";
import type { SizeBucket } from "./types";

export interface LlmSizeResult {
  band: SizeBucket | null;   // null unless confidence === "high"
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

const SYSTEM_PROMPT = `You size UK employers into headcount bands.

You are given the name a company posts jobs under (the employer brand a candidate would recognise). Decide how many people it employs IN THE UK, as a band.

Bands:
  startup     1-20
  small       21-100
  mid         101-500
  large       501-5000
  enterprise  5000+

Rules:
1. Reply with ONLY a JSON object. No prose before or after.
2. Judge the EMPLOYER BRAND as a jobseeker would understand it. "Aldi" is the UK supermarket, not a dormant holding entity. If the brand is a well-known UK employer, you almost certainly know its rough scale — say so.
3. You do NOT need a precise headcount. You only need the band. Confidence is HIGH whenever you are confident of the BAND, even if you could not name an exact number.
4. Use "high" when you recognise the brand and are confident of its band. Use "low" when the name is generic, ambiguous, or unknown to you (a small private firm you have never heard of).
5. Never guess a band for a company you do not recognise — that is what "low" is for. A wrong band is worse than no band.

Schema:
{"band": "startup"|"small"|"mid"|"large"|"enterprise", "confidence": "high"|"medium"|"low", "reasoning": "<one short sentence>"}`;

const VALID_BANDS: ReadonlySet<string> = new Set([
  "startup",
  "small",
  "mid",
  "large",
  "enterprise",
]);

/**
 * Ask Haiku 4.5 for the UK headcount band of an employer brand.
 *
 * `brandName` should be the name as posted on the job ad (what the candidate
 * sees), NOT the Companies House legal name — see the header note. The CH legal
 * name and SIC codes are passed as supporting context only, when we have them.
 *
 * Returns a null band for anything the model isn't highly confident about.
 */
export async function lookupSizeBandViaLlm(params: {
  brandName: string;
  chLegalName?: string | null;
  sicCodes?: string[] | null;
}): Promise<LlmSizeResult | null> {
  const { brandName, chLegalName, sicCodes } = params;
  if (!brandName?.trim()) return null;

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey: key });

  const lines = [`Employer brand: ${brandName.trim()}`];
  // Context only — the model is told to judge the brand, not the entity.
  if (chLegalName && chLegalName.toLowerCase() !== brandName.trim().toLowerCase()) {
    lines.push(`(Companies House may list this as: ${chLegalName} — treat as a hint only, it may be a subsidiary or the wrong entity.)`);
  }
  if (sicCodes && sicCodes.length) {
    lines.push(`(Industry SIC codes: ${sicCodes.join(", ")})`);
  }
  const userPrompt = `${lines.join("\n")}\n\nWhich UK headcount band? Return the JSON.`;

  let rawText = "";
  try {
    const resp = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });
    rawText = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (e) {
    console.error("[size-llm] Anthropic call failed", e);
    return null;
  }

  const parsed = safeParse(rawText);
  if (!parsed) {
    return { band: null, confidence: "low", reasoning: "unparseable model response" };
  }

  const confidence = normaliseConfidence(parsed.confidence);
  const bandRaw = parsed.band.toLowerCase().trim();
  const reasoning = parsed.reasoning.slice(0, 500);

  // Strict gate: only a recognised band at high confidence is trusted.
  if (confidence !== "high" || !VALID_BANDS.has(bandRaw)) {
    return { band: null, confidence, reasoning };
  }

  return { band: bandRaw as SizeBucket, confidence: "high", reasoning };
}

function safeParse(text: string): { band: string; confidence: string; reasoning: string } | null {
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  try {
    const obj = JSON.parse(match ? match[0] : stripped);
    if (typeof obj !== "object" || obj === null) return null;
    return {
      band: String(obj.band ?? ""),
      confidence: String(obj.confidence ?? "").toLowerCase(),
      reasoning: String(obj.reasoning ?? ""),
    };
  } catch {
    return null;
  }
}

function normaliseConfidence(raw: string): "high" | "medium" | "low" {
  const s = raw.toLowerCase().trim();
  if (s === "high") return "high";
  if (s === "medium") return "medium";
  return "low";
}

/** Band ordering, used to measure how far apart two size claims are. */
const BAND_ORDER: Record<string, number> = {
  startup: 0,
  small: 1,
  mid: 2,
  large: 3,
  enterprise: 4,
};

/**
 * Distance between two bands, in band-steps. Returns null if either is unknown.
 *
 * Used to detect a wrong-entity Companies House match: when a filed employee
 * count says `startup` but the brand is confidently `large`, the count belongs
 * to some other company (the Amazon Flex case).
 */
export function bandDistance(a: SizeBucket | null, b: SizeBucket | null): number | null {
  if (!a || !b) return null;
  const x = BAND_ORDER[a];
  const y = BAND_ORDER[b];
  if (x === undefined || y === undefined) return null;
  return Math.abs(x - y);
}
