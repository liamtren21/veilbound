use super::*;
use near_sdk::json_types::U64;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

fn caller(index: usize, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(accounts(index))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build());
}

#[test]
fn expired_field_reservations_refund_original_operator_after_rotation() {
    caller(0, 0);
    let mut core = Core::new(accounts(0), accounts(1), Base64VecU8(vec![1; 32]), "test-rules".into());
    core.set_paused(false);
    core.set_field_reward_operator(accounts(2));
    caller(2, 10u128.pow(24));
    core.fund_storage(None);
    caller(1, 0);
    core.ft_on_transfer(accounts(2), U128(100), "{\"operation_id\":\"field-fund\"}".into());
    let id = "a".repeat(64);
    caller(2, 0);
    core.reserve_field_reward(id.clone(), accounts(3), U128(60), U64(10));
    caller(0, 0);
    core.set_field_reward_operator(accounts(4));
    testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(0)).block_timestamp(10).build());
    core.release_field_reward(id.clone());
    core.release_field_reward(id);
    let source = core.get_balance(accounts(2));
    assert_eq!(source.available, U128(100));
    assert_eq!(source.reserved, U128(0));
    assert_eq!(core.get_balance(accounts(3)).available, U128(0));
    assert_eq!(core.get_total_allocated(), U128(100));
}

#[test]
fn deposits_credit_only_authenticated_copper_and_only_once() {
    caller(0, 0);
    let mut core = Core::new(
        accounts(0),
        accounts(1),
        Base64VecU8(vec![1; 32]),
        "test-rules".into(),
    );
    caller(2, 10u128.pow(24));
    core.fund_storage(None);
    let msg = "{\"operation_id\":\"deposit-1\"}".to_owned();
    assert!(matches!(
        core.ft_on_transfer(accounts(2), U128(100), msg.clone()),
        PromiseOrValue::Value(U128(100))
    ));
    caller(1, 0);
    assert!(matches!(
        core.ft_on_transfer(accounts(2), U128(100), msg.clone()),
        PromiseOrValue::Value(U128(0))
    ));
    assert!(matches!(
        core.ft_on_transfer(accounts(2), U128(100), msg),
        PromiseOrValue::Value(U128(100))
    ));
    assert_eq!(core.get_balance(accounts(2)).available, U128(100));
}

#[test]
fn withdrawal_reserves_before_dispatch() {
    caller(0, 0);
    let mut core = Core::new(
        accounts(0),
        accounts(1),
        Base64VecU8(vec![1; 32]),
        "test-rules".into(),
    );
    core.set_paused(false);
    caller(2, 10u128.pow(24));
    core.fund_storage(None);
    caller(1, 0);
    core.ft_on_transfer(accounts(2), U128(100), "{\"operation_id\":\"d\"}".into());
    caller(2, 1);
    core.withdraw("withdraw-1".into(), U128(60));
    let balance = core.get_balance(accounts(2));
    assert_eq!(balance.available, U128(40));
    assert_eq!(balance.reserved, U128(60));
}
