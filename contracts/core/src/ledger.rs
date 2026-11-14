use crate::receipts::RewardReceipt;
use near_sdk::json_types::U128;
use near_sdk::near;

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
pub struct Deposit {
    pub operation_id: String,
}

#[near(serializers = [borsh, json])]
#[derive(Default)]
pub struct Balance {
    pub available: U128,
    pub reserved: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Deposit,
    Withdraw,
    Reward,
}

#[near(serializers = [borsh, json])]
#[derive(PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Pending,
    Settled,
    Refunded,
    Expired,
}

#[near(serializers = [borsh, json])]
pub struct Operation {
    pub amount: U128,
    pub status: Status,
    pub receipt: Option<RewardReceipt>,
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_:.".contains(&byte))
}
