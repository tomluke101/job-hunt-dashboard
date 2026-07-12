// Companies House iXBRL employee-count extraction.
//
// Every UK company that files XBRL statutory accounts includes the tag
//   uk-bus:AverageNumberEmployeesDuringPeriod   (or a newer namespace variant)
// with the machine-readable employee count. This module chains three CH
// endpoints to get it:
//
//   1. GET /company/{n}/filing-history?category=accounts
//        → find latest non-paper annual-accounts (AA) filing
//   2. GET {links.document_metadata}
//        → confirm application/xhtml+xml resource + check size cap
//   3. GET {links.document_metadata}/content   Accept: application/xhtml+xml
//        → download iXBRL, regex-extract the tag
//
// Returns null (silently) when no XBRL filing exists, the document is paper-
// only, oversized, or the tag isn't present. The caller then falls back to
// the accounts-type + officers heuristic.

import { chFetchJson, chFetchDocJson, chFetchDocText, CHNotFoundError } from "./companies-house";

// Group accounts filings (large corporate parents like Aldi Stores) can be
// 5-8 MB of iXBRL XHTML. Cap at 10 MB — plenty of room, negligible memory
// cost inside a serverless function.
const MAX_DOC_BYTES = 10_000_000;

interface FilingHistoryItem {
  type?: string;
  category?: string;
  date?: string;
  paper_filed?: boolean;
  action_date?: string;
  links?: { document_metadata?: string };
}

interface FilingHistoryResponse {
  items?: FilingHistoryItem[];
}

interface DocumentMetadata {
  resources?: Record<string, { content_length?: number } | undefined>;
  created_at?: string;
  significant_date?: string;
}

export interface EmployeeCountResult {
  count: number | null;
  period_end: string | null;
  source_doc_url: string | null;
  // Machine-readable outcome so the debug UI can explain per-row why we
  // do or don't have a count. Fixed vocabulary:
  //   ok                        — count populated
  //   no-accounts-filing        — company has never filed XBRL accounts
  //   filing-paper-only         — latest accounts filing is paper (no iXBRL)
  //   no-xhtml-resource         — doc metadata doesn't expose xhtml+xml
  //   doc-too-large:N           — iXBRL file exceeds MAX_DOC_BYTES
  //   tag-not-found             — regex matched no employee-tag hit in the doc
  //   error:<msg>               — network/parse threw
  status: string;
}

/**
 * Chain filing-history → doc metadata → iXBRL content → parse.
 * Always returns a result object with a status string; the caller stores
 * both the count (nullable) and the status for debugging.
 */
export async function getLatestEmployeeCount(
  companyNumber: string
): Promise<EmployeeCountResult> {
  const empty = (status: string): EmployeeCountResult => ({
    count: null,
    period_end: null,
    source_doc_url: null,
    status,
  });

  let history: FilingHistoryResponse | null = null;
  try {
    history = await chFetchJson<FilingHistoryResponse>(
      `/company/${encodeURIComponent(companyNumber)}/filing-history?category=accounts&items_per_page=25`
    );
  } catch (e) {
    if (e instanceof CHNotFoundError) return empty("no-accounts-filing");
    return empty(`error:${(e as Error).message?.slice(0, 100)}`);
  }
  if (!history?.items?.length) return empty("no-accounts-filing");

  // Sort accounts filings newest-first, then prefer full annual accounts (AA)
  // over amendments (AA01) or auditor's-report filings that also live under
  // the accounts category but don't include the employee-count tag.
  const eligible = history.items
    .filter((it) => !it.paper_filed && it.links?.document_metadata)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  if (eligible.length === 0) {
    // At least one filing exists but they're all paper — no iXBRL to parse.
    return empty("filing-paper-only");
  }

  const preferred =
    eligible.find((f) => f.type === "AA") ??
    eligible.find((f) => f.type === "AAMD") ??
    eligible.find((f) => f.type === "AASX") ??
    eligible[0];
  const docMetaUrl = preferred?.links?.document_metadata;
  if (!docMetaUrl) return empty("filing-paper-only");

  let meta: DocumentMetadata | null = null;
  try {
    meta = await chFetchDocJson<DocumentMetadata>(docMetaUrl);
  } catch (e) {
    if (e instanceof CHNotFoundError) return empty("no-accounts-filing");
    return empty(`error:${(e as Error).message?.slice(0, 100)}`);
  }
  const xhtmlRes = meta?.resources?.["application/xhtml+xml"];
  if (!xhtmlRes) return empty("no-xhtml-resource");
  const size = xhtmlRes.content_length ?? 0;
  if (size > MAX_DOC_BYTES) return empty(`doc-too-large:${size}`);

  const contentUrl = `${docMetaUrl}/content`;
  const doc = await chFetchDocText(contentUrl, "application/xhtml+xml").catch(() => null);
  if (!doc) return empty("no-xhtml-resource");

  const count = parseEmployeeCount(doc);
  if (count === null) return empty("tag-not-found");

  return {
    count,
    period_end: preferred.date ?? preferred.action_date ?? meta.significant_date ?? null,
    source_doc_url: docMetaUrl,
    status: "ok",
  };
}

/**
 * Extract employee count from an iXBRL XHTML document.
 *
 * XBRL taxonomies used by UK filings over the years include:
 *   uk-bus:AverageNumberEmployeesDuringPeriod   (older UK-GAAP)
 *   uk-bus:AverageNumberEmployees               (short-form)
 *   uk-core:AverageNumberEmployees              (FRS 102 core)
 *   uk-frs-101:...                              (FRS 101)
 *   uk-frs-102:...                              (FRS 102 sections)
 *   core-eu:AverageNumberEmployeesDuringPeriod  (EU IFRS)
 *   nsN:AverageNumberEmployees                  (numeric auto-generated)
 *
 * The tag is always `<ix:nonFraction name="[prefix]:[tag]" ... >NUMBER</...>`.
 * The regex matches any prefix + accepts:
 *   AverageNumberEmployees, AverageNumberEmployeesDuringPeriod,
 *   AverageNumberOfEmployees, NumberOfEmployees, EmployeeNumbersTotal
 *
 * XBRL `scale="N"` attribute means displayed value = raw × 10^N (used for
 * thousands/millions). Rarely applied to headcount but we honour it to be safe.
 *
 * Multiple hits are common (current + comparative periods, group + parent).
 * Take the MAX — this is nearly always the group-total current-year value.
 */
export function parseEmployeeCount(ixbrl: string): number | null {
  const TAG_NAMES =
    "AverageNumberEmployees(?:DuringPeriod)?|AverageNumberOfEmployees|NumberOfEmployees|EmployeeNumbersTotal";
  const re = new RegExp(
    `<ix:nonFraction\\b([^>]*)\\bname="[^"]*(?:${TAG_NAMES})"([^>]*)>([\\s\\S]*?)<\\/ix:nonFraction>`,
    "gi"
  );
  const matches: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(ixbrl)) !== null) {
    const attrs = (m[1] ?? "") + (m[2] ?? "");
    const raw = m[3].replace(/<[^>]*>/g, "").replace(/,/g, "").trim();
    const base = parseInt(raw, 10);
    if (!Number.isFinite(base) || base <= 0) continue;
    const scaleMatch = /\bscale="(-?\d+)"/i.exec(attrs);
    const scale = scaleMatch ? parseInt(scaleMatch[1], 10) : 0;
    const value = Math.round(base * Math.pow(10, scale));
    if (value > 0 && value < 10_000_000) matches.push(value);
  }
  if (!matches.length) return null;
  return Math.max(...matches);
}
