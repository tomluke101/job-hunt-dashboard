/**
 * Throwaway probe: does asking Haiku for a SIZE BUCKET on the EMPLOYER BRAND
 * beat asking for a precise employee COUNT on the CH LEGAL ENTITY?
 *
 * The current production prompt asks for an exact headcount for a legal entity
 * ("ALDI STORES LIMITED", co. 0044105) and gates on high confidence — it
 * declined on 30 of 31 companies. Hypothesis: the question is too hard and
 * aimed at the wrong subject. The filter only needs a bucket, and the user is
 * filtering on the brand they'd actually work for.
 *
 *   npx tsx scripts/probe-size-llm.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

function loadEnvLocal() {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnvLocal();

const SYSTEM = `You size UK employers into headcount bands.

You are given the name a company posts jobs under (the employer brand a candidate would recognise). Decide how many people it employs IN THE UK, as a band.

Bands:
  startup     1-20
  small       21-100
  mid         101-500
  large       501-5000
  enterprise  5000+

Rules:
1. Reply with ONLY a JSON object. No prose.
2. Judge the EMPLOYER BRAND as a jobseeker would understand it. "Aldi" is the UK supermarket, not a dormant holding entity. If the brand is a well-known UK employer, you almost certainly know its rough scale — say so.
3. You do NOT need a precise headcount. You only need the band. Confidence is HIGH whenever you are confident of the BAND, even if you could not name an exact number.
4. Use "high" when you know the brand and are confident of its band. Use "low" when the name is generic, ambiguous, or unknown to you (a small private firm you have never heard of).
5. Never guess a band for a company you do not recognise — that is what "low" is for.

Schema:
{"band": "startup"|"small"|"mid"|"large"|"enterprise", "confidence": "high"|"medium"|"low", "reasoning": "<one short sentence>"}`;

// Real names from the live DB that the count-based prompt failed on,
// plus a couple it should still correctly refuse.
const NAMES = [
  "Aldi Stores",
  "Specsavers",
  "Co-op",
  "London Stock Exchange Group",
  "Brakes",
  "GXO Logistics",
  "Savers",
  "Amazon Flex",
  "Accent Housing Group",
  "BUZZ Bingo",
  "Outcomes First Group",
  "Aberdeenshire Council",
  // Should stay LOW — genuinely obscure:
  "Auricoe",
  "MRK Talent Solutions Ltd",
  "Elix Sourcing Solutions",
];

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  let high = 0;

  for (const name of NAMES) {
    const resp = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      system: SYSTEM,
      messages: [{ role: "user", content: `Employer brand: ${name}\n\nWhich UK headcount band? Return the JSON.` }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    let band = "?", conf = "?", why = "";
    try {
      const m = text.match(/\{[\s\S]*\}/);
      const o = JSON.parse(m ? m[0] : text);
      band = String(o.band);
      conf = String(o.confidence);
      why = String(o.reasoning ?? "");
    } catch {
      why = `UNPARSEABLE: ${text.slice(0, 60)}`;
    }
    if (conf === "high") high++;
    console.log(`${name.padEnd(30)} ${band.padEnd(11)} ${conf.padEnd(7)} ${why.slice(0, 70)}`);
  }
  console.log(`\nhigh-confidence: ${high}/${NAMES.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
