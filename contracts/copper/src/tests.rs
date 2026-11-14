use super::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;

fn caller(index: usize) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(accounts(index))
        .attached_deposit(NearToken::from_yoctonear(10u128.pow(22)))
        .build());
}

#[test]
#[should_panic(expected = "Insufficient receipt storage deposit")]
fn custody_receipts_require_storage_funding() {
    caller(0);
    let mut copper = Copper::new(accounts(0), accounts(1), U128(100), U128(100), U64(100), U128(100));
    testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(1)).build());
    copper.withdraw_custody("new-withdrawal".into(), accounts(2), U128(1));
}

#[test]
fn reward_budget_clears_previous_epoch_usage() {
    caller(0);
    let mut copper = Copper::new(accounts(0), accounts(1), U128(100), U128(100), U64(100), U128(100));
    caller(1);
    copper.mint_reward("one".into(), U128(50), U64(0), None);
    assert_eq!(copper.get_reward_budget().epoch_minted, U128(50));
    testing_env!(VMContextBuilder::new().block_timestamp(100).build());
    assert_eq!(copper.get_reward_budget().epoch_minted, U128(0));
    assert_eq!(copper.get_reward_budget().rewards_minted, U128(50));
}

#[test]
fn reward_and_burn_retries_preserve_supply() {
    caller(0);
    let mut copper = Copper::new(
        accounts(0),
        accounts(1),
        U128(1000),
        U128(1000),
        U64(100),
        U128(100),
    );
    assert_eq!(copper.ft_total_supply(), U128(0));
    assert_eq!(copper.ft_metadata().decimals, 2);
    caller(1);
    copper.mint_reward("reward-1".into(), U128(50), U64(0), None);
    copper.mint_reward("reward-1".into(), U128(50), U64(0), None);
    copper.burn_custody("burn-1".into(), U128(10));
    copper.burn_custody("burn-1".into(), U128(10));
    assert_eq!(copper.ft_balance_of(accounts(1)), U128(40));
    assert_eq!(copper.ft_total_supply(), U128(40));
}

#[test]
#[should_panic(expected = "Only Core")]
fn reward_mint_requires_core() {
    caller(0);
    let mut copper = Copper::new(
        accounts(0),
        accounts(1),
        U128(100),
        U128(100),
        U64(100),
        U128(100),
    );
    copper.mint_reward("reward-1".into(), U128(1), U64(0), None);
}

#[test]
#[should_panic(expected = "Epoch reward cap exceeded")]
fn rewards_share_epoch_cap() {
    caller(0);
    let mut copper = Copper::new(
        accounts(0),
        accounts(1),
        U128(1000),
        U128(1000),
        U64(100),
        U128(100),
    );
    caller(1);
    copper.mint_reward("reward-1".into(), U128(90), U64(0), None);
    copper.mint_reward("reward-2".into(), U128(11), U64(0), None);
}

#[test]
#[should_panic(expected = "Claim payload mismatch")]
fn retry_requires_same_payload() {
    caller(0);
    let mut copper = Copper::new(
        accounts(0),
        accounts(1),
        U128(1000),
        U128(1000),
        U64(100),
        U128(100),
    );
    caller(1);
    copper.mint_reward("reward-1".into(), U128(1), U64(0), None);
    copper.mint_reward("reward-1".into(), U128(2), U64(0), None);
}
