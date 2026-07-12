// The provider registry. Everything downstream (ingest, discovery, the probe
// script) goes through here rather than importing an adapter directly, so adding
// a provider is a one-line change and nothing can accidentally depend on a
// disabled one.

import type { AtsBoard, AtsProvider, AtsProviderId, AtsPullResult } from "../types";
import { ENABLED_PROVIDERS } from "../types";
import type { AtsProviderImpl, AtsPullOptions } from "./_util";

import { greenhouseProvider } from "./greenhouse";
import { leverProvider } from "./lever";
import { ashbyProvider } from "./ashby";
import { smartrecruitersProvider } from "./smartrecruiters";
import { recruiteeProvider } from "./recruitee";
import { workdayProvider } from "./workday";
import { workableProvider } from "./workable";

const IMPLS: Record<AtsProviderId, AtsProviderImpl> = {
  greenhouse: greenhouseProvider,
  lever: leverProvider,
  ashby: ashbyProvider,
  smartrecruiters: smartrecruitersProvider,
  recruitee: recruiteeProvider,
  workday: workdayProvider,
  workable: workableProvider,
};

/** The contract surface. `listJobs(board)` — no options; see pullBoard() for those. */
export const ATS_PROVIDERS: Record<AtsProviderId, AtsProvider> = IMPLS;

export function getProvider(id: AtsProviderId): AtsProvider {
  return ATS_PROVIDERS[id];
}

/**
 * Pull a board WITH a time/size budget.
 *
 * The budget only bites on SmartRecruiters and Workday, whose JD lives behind a
 * per-job detail request (an N+1). Anything driving a real ingest run should call
 * this rather than listJobs(), so a single slow enterprise board can't eat the
 * whole run's wall clock.
 */
export function pullBoard(board: AtsBoard, opts?: AtsPullOptions): Promise<AtsPullResult> {
  return IMPLS[board.provider].listJobs(board, opts);
}

/** Only the providers we've SEEN return real jobs. Ingest iterates this, not the record. */
export function enabledProviders(): AtsProvider[] {
  return ENABLED_PROVIDERS.map((id) => ATS_PROVIDERS[id]);
}

/**
 * Which provider does this careers-page URL belong to? Discovery scrapes a company
 * site, finds an "Apply"/"View jobs" link, and hands the href here.
 *
 * Each detect() is host-scoped, so at most one can ever match — order is irrelevant.
 */
export function detectBoard(url: string): AtsBoard | null {
  for (const id of Object.keys(IMPLS) as AtsProviderId[]) {
    const board = IMPLS[id].detect(url);
    if (board) return board;
  }
  return null;
}

export {
  WORKDAY_WRONG_SITE,
  WORKDAY_WRONG_HOST,
  DEFAULT_WORKDAY_SITES,
  DEFAULT_WORKDAY_HOSTS,
  probeSites,
  findWorkdayBoard,
} from "./workday";
export type { AtsPullOptions, AtsProviderImpl } from "./_util";
