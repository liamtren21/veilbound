use crate::{Core, CoreExt};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId};

const MAX_RESERVATION_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FieldStatus {
    Reserved,
    Paid,
    Released,
}

#[near(serializers = [borsh, json])]
pub struct FieldReward {
    pub beneficiary: AccountId,
    pub amount: U128,
    pub expires_at_ns: U64,
    pub status: FieldStatus,
    pub operator_id: AccountId,
}

fn reservations() -> LookupMap<String, FieldReward> {
    LookupMap::new(b"field-rewards-v1".to_vec())
}

fn operators() -> LookupMap<u8, AccountId> {
    LookupMap::new(b"field-operator-v1".to_vec())
}

#[near]
impl Core {
    pub fn set_field_reward_operator(&mut self, operator_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        require!(
            operator_id != env::current_account_id(),
            "Invalid field operator"
        );
        operators().insert(&0, &operator_id);
    }

    pub fn get_field_reward_operator(&self) -> Option<AccountId> {
        operators().get(&0)
    }

    pub fn get_field_reward(&self, reservation_id: String) -> Option<FieldReward> {
        reservations().get(&reservation_id)
    }

    pub fn reserve_field_reward(
        &mut self,
        operation_id: String,
        beneficiary: AccountId,
        amount: U128,
        expires_at_ns: U64,
    ) -> FieldReward {
        let operator_id = env::predecessor_account_id();
        require!(
            self.get_field_reward_operator().as_ref() == Some(&operator_id),
            "Only field operator"
        );
        require!(
            operation_id.len() == 64
                && operation_id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "Invalid reservation ID"
        );
        require!(
            beneficiary != operator_id && beneficiary != env::current_account_id() && amount.0 > 0,
            "Invalid field reward"
        );
        if let Some(existing) = reservations().get(&operation_id) {
            require!(
                existing.operator_id == operator_id
                    && existing.beneficiary == beneficiary
                    && existing.amount == amount
                    && existing.expires_at_ns == expires_at_ns,
                "Reservation payload mismatch"
            );
            return existing;
        }
        require!(!self.paused, "Core paused");
        let now = env::block_timestamp();
        require!(
            expires_at_ns.0 > now && expires_at_ns.0 - now <= MAX_RESERVATION_NS,
            "Invalid field reward expiry"
        );
        let mut source = self.get_balance(operator_id.clone());
        require!(source.available.0 >= amount.0, "Insufficient field Copper");
        self.charge_storage(&operator_id, 600);
        source.available.0 -= amount.0;
        source.reserved.0 = source
            .reserved
            .0
            .checked_add(amount.0)
            .expect("Reserve overflow");
        self.balances.insert(&operator_id, &source);
        let reward = FieldReward {
            beneficiary,
            amount,
            expires_at_ns,
            status: FieldStatus::Reserved,
            operator_id,
        };
        reservations().insert(&operation_id, &reward);
        reward
    }

    pub fn pay_field_reward(&mut self, reservation_id: String) -> FieldReward {
        let mut reward = reservations()
            .get(&reservation_id)
            .expect("Unknown field reward");
        let caller = env::predecessor_account_id();
        require!(
            caller == reward.operator_id
                && self.get_field_reward_operator().as_ref() == Some(&caller),
            "Only field operator"
        );
        if reward.status == FieldStatus::Paid {
            return reward;
        }
        require!(
            reward.status == FieldStatus::Reserved
                && env::block_timestamp() < reward.expires_at_ns.0,
            "Field reward unavailable"
        );
        let mut source = self.get_balance(reward.operator_id.clone());
        let mut target = self.get_balance(reward.beneficiary.clone());
        source.reserved.0 -= reward.amount.0;
        target.available.0 = target
            .available
            .0
            .checked_add(reward.amount.0)
            .expect("Balance overflow");
        self.balances.insert(&reward.operator_id, &source);
        self.balances.insert(&reward.beneficiary, &target);
        reward.status = FieldStatus::Paid;
        reservations().insert(&reservation_id, &reward);
        reward
    }

    pub fn release_field_reward(&mut self, reservation_id: String) -> FieldReward {
        let mut reward = reservations()
            .get(&reservation_id)
            .expect("Unknown field reward");
        let caller = env::predecessor_account_id();
        let active_operator = caller == reward.operator_id
            && self.get_field_reward_operator().as_ref() == Some(&caller);
        let expired_owner_recovery =
            caller == self.owner_id && env::block_timestamp() >= reward.expires_at_ns.0;
        require!(
            active_operator || expired_owner_recovery,
            "Only field operator or expired owner recovery"
        );
        if reward.status == FieldStatus::Released {
            return reward;
        }
        require!(
            reward.status == FieldStatus::Reserved,
            "Field reward already paid"
        );
        let mut source = self.get_balance(reward.operator_id.clone());
        source.reserved.0 -= reward.amount.0;
        source.available.0 = source
            .available
            .0
            .checked_add(reward.amount.0)
            .expect("Balance overflow");
        self.balances.insert(&reward.operator_id, &source);
        reward.status = FieldStatus::Released;
        reservations().insert(&reservation_id, &reward);
        reward
    }
}
