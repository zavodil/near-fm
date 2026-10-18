//! JustHoot — https://justhoot.fun (no public docs; read from the contract and
//! the site's own front end, October 2026).
//!
//! Factory `launchpad.justhoot.near`, method `launch_meme({args})`, 1000 TGas,
//! deposit from `get_launch_deposit({args, account_id})`. A launch creates the
//! token `<symbol>-<6 hex>.launchpad.justhoot.near` and a Rhea DCL pool against
//! the quote token in one transaction. The token contract answers `ft_metadata`,
//! `get_config` (`owner_id` = creator) and `get_launch_state` (`liquidity_sent`
//! once the pool is live, `dcl_setup_failed` when it stalled).
//!
//! There is no view listing launches by creator: `get_launched_tokens` is the
//! factory's full list in launch order, and token ids start with the lowercased
//! symbol, so the author's launch is found by scanning the newest ids.

use serde_json::{json, Value};

use super::FoundLaunch;

pub const ID: &str = "justhoot.fun";
pub const FACTORY: &str = "launchpad.justhoot.near";
const TOKEN_SUFFIX: &str = ".launchpad.justhoot.near";
/// How many of the newest launches to scan for the author's one.
const SCAN_LIMIT: u64 = 50;

pub fn is_factory_token(token: &str) -> bool {
    token.ends_with(TOKEN_SUFFIX) && token.len() > TOKEN_SUFFIX.len()
}

/// `symbol` as it appears at the start of the token id (`NSLT` → `nslt-`).
fn token_prefix(symbol: &str) -> String {
    format!("{}-", symbol.trim().to_ascii_lowercase())
}

fn is_live(state: &Value) -> bool {
    state["liquidity_sent"].as_bool() == Some(true) && state["dcl_setup_failed"].as_bool() != Some(true)
}

/// Read one token the factory launched. `Ok(None)` when it is not one of ours.
pub async fn get_launch_by_token(rpc_url: &str, token: &str) -> Result<Option<FoundLaunch>, String> {
    if !is_factory_token(token) {
        return Ok(None);
    }
    let known = crate::near::rpc::view_call(rpc_url, FACTORY, "is_launched_token", &json!({ "token_id": token })).await?;
    if known.as_bool() != Some(true) {
        return Ok(None);
    }
    let no_args = json!({});
    let (meta, config, state) = tokio::try_join!(
        crate::near::rpc::view_call(rpc_url, token, "ft_metadata", &no_args),
        crate::near::rpc::view_call(rpc_url, token, "get_config", &no_args),
        crate::near::rpc::view_call(rpc_url, token, "get_launch_state", &no_args),
    )?;
    let creator = config["owner_id"].as_str().ok_or("get_config: no owner_id")?.to_string();
    Ok(Some(FoundLaunch {
        token_account: token.to_string(),
        launch_id: None,
        creator,
        name: meta["name"].as_str().unwrap_or_default().to_string(),
        symbol: meta["symbol"].as_str().unwrap_or_default().to_string(),
        description: None,
        // The factory keeps no timestamp; the caller's "since" check does not apply.
        created_at_ms: 0,
        live: is_live(&state),
    }))
}

/// Newest launch by `creator` whose token id starts with `symbol`.
pub async fn find_launch(rpc_url: &str, creator: &str, symbol: &str, _since_ms: u64) -> Result<Option<FoundLaunch>, String> {
    let count = crate::near::rpc::view_call(rpc_url, FACTORY, "get_launched_tokens_count", &json!({})).await?;
    let count = count.as_u64().or_else(|| count.as_str().and_then(|s| s.parse().ok())).ok_or("get_launched_tokens_count: not a number")?;
    let from = count.saturating_sub(SCAN_LIMIT);
    let ids = crate::near::rpc::view_call(rpc_url, FACTORY, "get_launched_tokens", &json!({ "from_index": from, "limit": SCAN_LIMIT })).await?;
    let ids = ids.as_array().ok_or("get_launched_tokens: not a list")?;
    let prefix = token_prefix(symbol);
    // Newest first; only ids that can be this symbol's, so one or two reads.
    for id in ids.iter().rev().filter_map(Value::as_str).filter(|id| id.starts_with(&prefix)) {
        if let Some(l) = get_launch_by_token(rpc_url, id).await? {
            if l.creator == creator && l.symbol.eq_ignore_ascii_case(symbol.trim()) {
                return Ok(Some(l));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_and_factory_checks() {
        assert_eq!(token_prefix(" NSLT "), "nslt-");
        assert!(is_factory_token("nslt-77d04d.launchpad.justhoot.near"));
        assert!(!is_factory_token("nslt.nearlytrade.near"));
        assert!(!is_factory_token(".launchpad.justhoot.near"));
        assert!(is_live(&json!({"liquidity_sent": true, "dcl_setup_failed": false})));
        assert!(!is_live(&json!({"liquidity_sent": true, "dcl_setup_failed": true})));
        assert!(!is_live(&json!({"liquidity_sent": false})));
    }
}

#[cfg(test)]
mod live_tests {
    /// Reads mainnet. Run by hand: cargo test -- --ignored justhoot_live
    #[tokio::test]
    #[ignore]
    async fn justhoot_live_find_and_get() {
        let rpc = "https://rpc.mainnet.fastnear.com";
        let g = super::get_launch_by_token(rpc, "nslt-77d04d.launchpad.justhoot.near").await.unwrap().expect("NSLT");
        assert_eq!(g.creator, "toughpuma1933.near");
        assert_eq!(g.symbol, "NSLT");
        assert!(g.live);
        assert!(super::get_launch_by_token(rpc, "zz-nonono.launchpad.justhoot.near").await.unwrap().is_none());
        assert!(super::get_launch_by_token(rpc, "rtl.nearlytrade.near").await.unwrap().is_none());
        let f = super::find_launch(rpc, "toughpuma1933.near", "nslt", 0).await.unwrap();
        assert!(f.is_some(), "find by creator+symbol (fails once NSLT leaves the newest 50)");
        assert!(super::find_launch(rpc, "someone-else.near", "NSLT", 0).await.unwrap().is_none(), "creator filter");
    }
}
