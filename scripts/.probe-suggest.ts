import { suggestTitles } from "@/lib/job-search/title-suggestions";

// Reproduce Tom's exact flow: type "supply chain ana" into the chip input.
const typing = suggestTitles({ keywords: "", description: "", buffer: "supply chain ana" }, [], 6);
console.log('buffer="supply chain ana" ->', typing);

// The old bug: the search NAME fed the suggester, so naming a search "Test"
// produced Test Engineer / Test Analyst / Test Manager. Name is no longer an
// input at all, so an empty keywords/description yields nothing.
const nameLeak = suggestTitles({ keywords: "", description: "", buffer: "" }, [], 6);
console.log('name="Test" (no longer an input), empty kw/desc ->', nameLeak);

// Keywords still drive related-roles when the buffer is empty.
const fromKeywords = suggestTitles(
  { keywords: "supply chain analyst", description: "", buffer: "" },
  ["Supply Chain Analyst"],
  6
);
console.log('keywords="supply chain analyst" ->', fromKeywords);

// blur/Enter resolution rule (mirrors resolveBuffer in SearchEditor):
function resolveBuffer(raw: string, suggestions: string[]): string {
  const top = suggestions[0];
  if (!top) return raw;
  const typed = raw.toLowerCase().replace(/\s+/g, " ").trim();
  const match = top.toLowerCase().replace(/\s+/g, " ").trim();
  if (!match.startsWith(typed) || match.length === typed.length) return raw;
  if (match.split(" ").length !== typed.split(" ").length) return raw;
  return top;
}
const cases = ["supply chain ana", "data", "Buyer", "Head of Widgets"];
console.log("\nblur/Enter resolution:");
for (const c of cases) {
  const sug = suggestTitles({ keywords: "", description: "", buffer: c }, [], 6);
  console.log(`  "${c}".padEnd -> "${resolveBuffer(c, sug)}"`);
}
