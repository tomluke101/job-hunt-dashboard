// Companies House REST client — shared for all CH endpoints.
//
// Two hosts, both same Basic auth (key as username, empty password) and same
// 600/5min rate limit pool:
//   • api.company-information.service.gov.uk        — profile, search, filing history, officers
//   • document-api.company-information.service.gov.uk — accounts + articles document content
//
// Process-local rate limiter enforces 550ms min gap between calls. That's
// safely under the 2/sec ceiling and holds across BOTH hosts.

const API_BASE_URL = "https://api.company-information.service.gov.uk";
const DOC_BASE_URL = "https://document-api.company-information.service.gov.uk";
const MIN_GAP_MS = 550;
const RETRY_BACKOFF_MS = [1000, 3000];

let lastCallAt = 0;

function getApiKey(): string {
  const k = process.env.COMPANIES_HOUSE_API_KEY;
  if (!k) throw new Error("COMPANIES_HOUSE_API_KEY not set");
  return k;
}

function authHeader(): string {
  const key = getApiKey();
  const b64 = Buffer.from(`${key}:`).toString("base64");
  return `Basic ${b64}`;
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, lastCallAt + MIN_GAP_MS - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export class CHNotFoundError extends Error {}

// Absolute-URL fetch with retries + rate-limit + typed 404. Callers pass a
// complete URL so this works with BOTH the api. and document-api. hosts.
async function chFetchRaw(url: string, accept: string): Promise<Response> {
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    await throttle();
    const res = await fetch(url, {
      headers: {
        Authorization: authHeader(),
        Accept: accept,
      },
      cache: "no-store",
      redirect: "follow",
    });
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < RETRY_BACKOFF_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
      continue;
    }
    if (res.status === 404) throw new CHNotFoundError(`CH 404: ${url}`);
    const body = await res.text().catch(() => "");
    throw new Error(`Companies House ${res.status} ${res.statusText} for ${url}: ${body.slice(0, 200)}`);
  }
  throw new Error(`Companies House request exhausted retries for ${url}`);
}

// JSON call on the main API — accepts relative /... path.
export async function chFetchJson<T>(pathOrUrl: string): Promise<T> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API_BASE_URL}${pathOrUrl}`;
  const res = await chFetchRaw(url, "application/json");
  return (await res.json()) as T;
}

// JSON call on the DOCUMENT API — takes absolute doc-metadata URL from
// filing-history responses. Returned metadata is a resources map plus dates.
export async function chFetchDocJson<T>(url: string): Promise<T> {
  const res = await chFetchRaw(url, "application/json");
  return (await res.json()) as T;
}

// Text (XHTML / iXBRL) fetch — used for downloading statutory accounts docs.
// The document API 302-redirects to a signed S3 URL; Node fetch follows.
// Returns null on 404 (typed) so the caller can gracefully skip missing docs.
export async function chFetchDocText(url: string, accept: string): Promise<string | null> {
  try {
    const res = await chFetchRaw(url, accept);
    return await res.text();
  } catch (e) {
    if (e instanceof CHNotFoundError) return null;
    throw e;
  }
}

// ---- Typed helpers over chFetchJson ----

import type { CHSearchCandidate, CHCompanyProfile, CHOfficersSummary } from "./types";

export async function searchCompanies(
  name: string,
  itemsPerPage = 25
): Promise<CHSearchCandidate[]> {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const q = encodeURIComponent(trimmed);
  const data = await chFetchJson<{ items?: CHSearchCandidate[] }>(
    `/search/companies?q=${q}&items_per_page=${itemsPerPage}`
  );
  return data.items ?? [];
}

export async function getCompanyProfile(companyNumber: string): Promise<CHCompanyProfile> {
  return chFetchJson<CHCompanyProfile>(`/company/${encodeURIComponent(companyNumber)}`);
}

export async function getCompanyOfficersSummary(companyNumber: string): Promise<CHOfficersSummary> {
  const data = await chFetchJson<CHOfficersSummary>(
    `/company/${encodeURIComponent(companyNumber)}/officers?items_per_page=1`
  );
  return data;
}

export const CH_DOC_BASE_URL = DOC_BASE_URL;
