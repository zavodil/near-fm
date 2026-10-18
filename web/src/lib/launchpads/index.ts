import type { Launchpad } from "./types";
import { nearlyTrade } from "./nearlyTrade";
import { justHoot } from "./justHoot";

export type { Launchpad, LaunchForm, LaunchpadConfig, LaunchContext, LaunchRef, CostQuote, PairOption, Tax, TaxSplit, FeeMode, ViewFn } from "./types";

/** Launchpads shown in the picker. */
export const LAUNCHPADS: Launchpad[] = [nearlyTrade, justHoot];

export function getLaunchpad(id: string): Launchpad | undefined {
  return LAUNCHPADS.find((l) => l.id === id);
}
