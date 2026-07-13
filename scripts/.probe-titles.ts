import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

async function main() {
  const { reedAdapter } = await import("@/lib/job-search/sources/reed");
  const { adzunaAdapter } = await import("@/lib/job-search/sources/adzuna");

  const pullInput = {
    keywords: "supply chain analyst",
    locationText: "B3 2JR",
    postcode: "B3 2JR",
    radiusMiles: 25,
    minSalary: null,
    maxSalary: null,
    limit: 50,
    sinceDate: null,
  };

  for (const src of [reedAdapter, adzunaAdapter]) {
    const r = await src.pull(pullInput as never);
    console.log(`\n===== ${src.type}: ${r.jobs.length} jobs${r.error ? ` (error: ${r.error})` : ""}`);
    for (const j of r.jobs.slice(0, 30)) {
      console.log(`  ${String(j.title).slice(0, 60).padEnd(62)} @ ${String(j.company).slice(0, 30)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
