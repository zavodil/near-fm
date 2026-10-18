/**
 * Memecoin launchpads near.fm can launch a song's coin on.
 *
 * Everything launchpad-specific (contract ids, method names, argument shapes,
 * cost rules) lives behind this interface, one module per launchpad. The UI
 * and the server only speak in these types, so a launchpad changing its
 * contract means editing its adapter and nothing else.
 */

export type ViewFn = (contractId: string, method: string, args: Record<string, unknown>) => Promise<unknown>;

export interface LaunchTx {
  contractId: string;
  method: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
}

/** An asset the coin can be paired with (what buyers pay in). */
export interface PairOption {
  tokenId: string;
  symbol: string;
  decimals: number;
  /** The chain's native coin (NEAR). First buys are only available here. */
  native: boolean;
}

export interface TaxSplit {
  creator_bps: number;
  burn_bps: number;
  holders_bps: number;
}

export interface Tax extends TaxSplit {
  buy_bps: number;
  sell_bps: number;
}

export type FeeMode = "creator" | "holders" | "other";

export interface LaunchForm {
  name: string;
  symbol: string;
  description: string;
  /** `data:image/...` URI, already compressed to the launchpad's limit. */
  icon: string | null;
  links: { website: string | null; twitter: string | null; telegram: string | null };
  feeMode: FeeMode;
  /** Receiving wallet when `feeMode` is `other`. */
  feeTo: string | null;
  tax: Tax | null;
  /** Pair asset token id; `null` for the native coin. */
  pair: string | null;
  /** First buy in yocto (native pair only). */
  devBuyYocto: string | null;
}

export interface LaunchpadConfig {
  maxIconBytes: number;
  /** Square sizes to try when compressing the icon, largest first. */
  iconSizes?: number[];
  maxTaxBps: number;
  /** First-buy cap, in yocto of the native coin. */
  devBuyCapYocto: string;
  /** What the cap means, for the label ("4% of supply"). */
  devBuyCapLabel: string;
  pairs: PairOption[];
  /** Opening fully-diluted value, as the launchpad states it. */
  openingFdvLabel: string;
}

export interface CostQuote {
  totalYocto: string;
  items: { label: string; yocto: string }[];
}

/** What the launch UI needs to know about the song (for hosted metadata etc.). */
export interface LaunchContext {
  songUuid: string;
}

/** Which launch the status poll is about: the sequence number taken before
 *  launching, and the token account once near.fm has found the launch. */
export interface LaunchRef {
  launchId: number;
  tokenAccount: string | null;
}

export interface Launchpad {
  id: string;
  name: string;
  url: string;
  /** Path under /public. */
  logo: string;
  /** Listed in the picker but not launchable yet. */
  comingSoon?: boolean;
  limits: {
    nameMax: number;
    symbolPattern: RegExp;
    symbolMax: number;
    symbolHint: string;
    descriptionMax: number;
    linkMax: number;
  };
  /** Which of the generic form's controls apply here. */
  features: {
    /** Fee destinations the launchpad offers; empty hides the selector (the split below decides). */
    feeModes: FeeMode[];
    /** `buy-sell`: separate buy/sell taxes; `transfer`: one tax on every transfer. */
    taxMode: "buy-sell" | "transfer";
    /** Per side, in whole percent. */
    taxMaxPct: number;
  };
  /** Explanations shown under the controls, in the launchpad's own terms. */
  copy: {
    fees: string;
    tax: string;
    pair: string;
    firstBuy: string;
    /** Example token account for the ticker hint. */
    tokenAccountExample: string;
  };
  taxPresets: { label: string; split: TaxSplit }[];
  loadConfig(view: ViewFn): Promise<LaunchpadConfig>;
  quoteCost(view: ViewFn, form: LaunchForm): Promise<CostQuote>;
  /** Launch sequence number the next launch will get (for finding it afterwards). */
  nextLaunchId(view: ViewFn): Promise<number>;
  /** May do work first (e.g. host the coin's metadata) — always call right before signing. */
  buildTransactions(form: LaunchForm, totalYocto: string, nextLaunchId: number, ctx: LaunchContext): Promise<LaunchTx[]>;
  /** Where a launch stands on chain: finished, still being carried out, or stalled. */
  launchStatus(view: ViewFn, ref: LaunchRef): Promise<{ done: boolean; inFlight: boolean; tokenAccount: string | null }>;
  tokenUrl(tokenAccount: string): string;
}
