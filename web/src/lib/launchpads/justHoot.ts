/**
 * JustHoot adapter — https://justhoot.fun (no public docs; read from the
 * contract and the site's own front end, October 2026).
 *
 * `launch_meme({args})` on `launchpad.justhoot.near` with 1000 TGas and the
 * deposit from `get_launch_deposit`, which already includes the first buy.
 * The caller becomes the token owner. Fixed 1B supply; a Rhea DCL pool opens
 * in the same transaction at a $5,000 FDV (priced by the launchpad's oracle),
 * so any quote asset opens at the same value. Unused deposit is refunded.
 *
 * Description and links are not launch arguments: they live in a `reference`
 * JSON whose URL and sha256 go into the token's metadata. near.fm hosts it.
 */

import { uploadCoinReference } from "@/lib/api";
import type { CostQuote, LaunchForm, Launchpad, LaunchpadConfig, LaunchTx, PairOption, ViewFn } from "./types";

export const FACTORY = "launchpad.justhoot.near";
const LAUNCH_GAS = "1000000000000000"; // 1000 TGas, as the launchpad's own UI sends
const NATIVE = "wrap.near";
/** Only pairs the launchpad's own UI offers. */
const PAIRS: PairOption[] = [
  { tokenId: NATIVE, symbol: "NEAR", decimals: 24, native: true },
  { tokenId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", symbol: "USDC", decimals: 6, native: false },
  { tokenId: "usdt.tether-token.near", symbol: "USDT", decimals: 6, native: false },
];
/** Storage registration the factory may charge on top of its quote; refunded if unused. */
const STORAGE_MARGIN_YOCTO = BigInt("4000000000000000000000"); // 0.004 NEAR
/** First buy offered up to this share of the opening FDV (the pool price rises as you buy). */
const DEV_BUY_CAP_OF_FDV = 0.25;
/** Placeholder of the hosted reference's size, so the quote covers its storage. */
const REFERENCE_PLACEHOLDER = { url: "x".repeat(106), hash: "A".repeat(44) };

function hasReference(form: LaunchForm): boolean {
  return !!(form.description.trim() || form.links.website || form.links.twitter || form.links.telegram);
}

/** The launch's own argument object, exactly as the factory reads it. */
export function launchArgs(form: LaunchForm, reference: { url: string; hash: string } | null): Record<string, unknown> {
  // bps → pips (1% = 100 bps = 10,000 pips). One tax on every transfer.
  const feePips = form.tax ? Math.max(form.tax.buy_bps, form.tax.sell_bps) * 100 : 0;
  const split = form.tax ?? (form.feeMode === "holders"
    ? { creator_bps: 0, burn_bps: 0, holders_bps: 10000 }
    : { creator_bps: 10000, burn_bps: 0, holders_bps: 0 });
  return {
    name: form.name.trim(),
    symbol: form.symbol.trim().toUpperCase(),
    icon: form.icon || null,
    reference: reference?.url ?? null,
    reference_hash: reference?.hash ?? null,
    quote_token_id: form.pair ?? NATIVE,
    dev_buy_quote_max: form.devBuyYocto && form.devBuyYocto !== "0" ? form.devBuyYocto : null,
    transfer_fee_pips: feePips,
    shares: { token_owner_bps: split.creator_bps, burn_bps: split.burn_bps, holders_bps: split.holders_bps },
  };
}

async function launchDeposit(view: ViewFn, args: Record<string, unknown>): Promise<bigint> {
  const d = (await view(FACTORY, "get_launch_deposit", { args, account_id: null })) as string;
  return BigInt(d);
}

export const justHoot: Launchpad = {
  id: "justhoot.fun",
  name: "JustHoot",
  url: "https://justhoot.fun",
  logo: "/launchpads/justhoot.png",
  limits: {
    nameMax: 32,
    symbolPattern: /^[A-Z0-9]{2,10}$/,
    symbolMax: 10,
    symbolHint: "2 to 10 letters or digits",
    descriptionMax: 500,
    linkMax: 200,
  },
  features: {
    feeModes: [],
    taxMode: "transfer",
    taxMaxPct: 5,
  },
  copy: {
    fees: "Every trade pays a 1% pool fee. JustHoot keeps a platform share; the rest is split as you choose below, between you, burning and holders. Locked at launch.",
    tax: "An extra cut taken in the token on every transfer, buys and sells included, on top of the pool fee. Split the same way as the fees. Locked at launch.",
    pair: "The asset the pool holds against your token and that fees arrive in. Any pair opens at the same $5,000 value. First buy is only available on NEAR.",
    firstBuy: "Buys tokens for you from the pool the moment it opens, before anyone else. The price rises as you buy; whatever the pool can't fill is refunded.",
    tokenAccountExample: "nit-3f9a2c.launchpad.justhoot.near",
  },
  taxPresets: [
    { label: "All to you", split: { creator_bps: 10000, burn_bps: 0, holders_bps: 0 } },
    { label: "Balanced", split: { creator_bps: 4000, burn_bps: 3000, holders_bps: 3000 } },
    { label: "Holders first", split: { creator_bps: 4000, burn_bps: 1000, holders_bps: 5000 } },
    { label: "Burn heavy", split: { creator_bps: 2000, burn_bps: 6000, holders_bps: 2000 } },
  ],

  async loadConfig(view): Promise<LaunchpadConfig> {
    const [platform, price, allowed] = await Promise.all([
      view(FACTORY, "get_platform_config", {}) as Promise<{ initial_fiat_fdv: number; total_supply: string }>,
      view(FACTORY, "get_last_quote_price", { token_id: NATIVE }) as Promise<{ price: string; expo: number } | null>,
      view(FACTORY, "get_allowed_quote_tokens", {}) as Promise<string[]>,
    ]);
    if (!price) throw new Error("JustHoot has no NEAR price right now; try again in a minute");
    const nearUsd = Number(price.price) * 10 ** price.expo;
    if (!(nearUsd > 0)) throw new Error("JustHoot's NEAR price looks wrong; try again in a minute");
    const fdvNear = platform.initial_fiat_fdv / nearUsd;
    const capYocto = BigInt(Math.round(fdvNear * DEV_BUY_CAP_OF_FDV * 1e6)) * BigInt("1000000000000000000");
    const pairs = PAIRS.filter((p) => allowed.includes(p.tokenId));
    return {
      maxIconBytes: 7000, // the launchpad's own cap on the data URI
      iconSizes: [128, 112, 96],
      maxTaxBps: 500,
      devBuyCapYocto: capYocto.toString(),
      devBuyCapLabel: "a quarter of the opening value",
      pairs,
      openingFdvLabel: `$${platform.initial_fiat_fdv.toLocaleString()} (~${Math.round(fdvNear).toLocaleString()} NEAR)`,
    };
  },

  async quoteCost(view, form): Promise<CostQuote> {
    // With `account_id: null` the quote is storage and fees only (it grows a
    // little when a first buy is set, for its records); the first buy itself
    // is attached on top in NEAR and wrapped by the factory. Checked against
    // a real launch: attached = this quote + first buy, excess refunded.
    const args = launchArgs(form, hasReference(form) ? REFERENCE_PLACEHOLDER : null);
    const storage = await launchDeposit(view, args);
    const devBuy = BigInt(form.devBuyYocto && form.devBuyYocto !== "0" ? form.devBuyYocto : "0");
    const items = [{ label: "Token + pool storage", yocto: storage.toString() }];
    if (devBuy > BigInt(0)) items.push({ label: "First buy", yocto: devBuy.toString() });
    return { totalYocto: (storage + devBuy + STORAGE_MARGIN_YOCTO).toString(), items };
  },

  async nextLaunchId(view): Promise<number> {
    return Number(await view(FACTORY, "get_launched_tokens_count", {}));
  },

  async buildTransactions(form, totalYocto, _nextLaunchId, ctx): Promise<LaunchTx[]> {
    let reference: { url: string; hash: string } | null = null;
    if (hasReference(form)) {
      const r = await uploadCoinReference(ctx.songUuid, {
        description: form.description.trim() || undefined,
        website: form.links.website ?? undefined,
        twitter: form.links.twitter ?? undefined,
        telegram: form.links.telegram ?? undefined,
      });
      reference = { url: r.url, hash: r.hash_base64 };
    }
    // One transaction: token, pool and any first buy are carried out by the factory.
    return [{ contractId: FACTORY, method: "launch_meme", args: { args: launchArgs(form, reference) }, gas: LAUNCH_GAS, deposit: totalYocto }];
  },

  async launchStatus(view, ref) {
    // The token account is only known once near.fm has found the launch.
    if (!ref.tokenAccount) return { done: false, inFlight: true, tokenAccount: null };
    const s = (await view(ref.tokenAccount, "get_launch_state", {})) as { liquidity_sent?: boolean; dcl_setup_failed?: boolean };
    const failed = s.dcl_setup_failed === true;
    const done = s.liquidity_sent === true && !failed;
    return { done, inFlight: !done && !failed, tokenAccount: ref.tokenAccount };
  },

  tokenUrl(tokenAccount) {
    return `https://justhoot.fun/p/${tokenAccount}`;
  },
};
