use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::{near, require, AccountId};

#[near(serializers = [borsh, json])]
#[derive(PartialEq)]
pub struct Claim {
    pub receiver_id: AccountId,
    pub amount: U128,
    pub epoch: Option<U64>,
}

#[near(serializers = [borsh])]
pub struct Emissions {
    pub claims: LookupMap<String, Claim>,
    pub epoch_length_ns: u64,
    bootstrap_cap: u128,
    bootstrap_minted: u128,
    global_reward_cap: u128,
    rewards_minted: u128,
    epoch_reward_cap: u128,
    last_epoch: u64,
    epoch_minted: u128,
}

#[near(serializers = [json])]
pub struct RewardBudget {
    pub epoch: U64,
    pub epoch_length_ns: U64,
    pub global_reward_cap: U128,
    pub rewards_minted: U128,
    pub epoch_reward_cap: U128,
    pub epoch_minted: U128,
}

impl Emissions {
    pub fn budget(&self, epoch: u64) -> RewardBudget {
        RewardBudget {
            epoch: U64(epoch), epoch_length_ns: U64(self.epoch_length_ns),
            global_reward_cap: U128(self.global_reward_cap), rewards_minted: U128(self.rewards_minted),
            epoch_reward_cap: U128(self.epoch_reward_cap),
            epoch_minted: U128(if epoch == self.last_epoch { self.epoch_minted } else { 0 }),
        }
    }
    pub fn new(
        bootstrap_cap: u128,
        global_reward_cap: u128,
        epoch_length_ns: u64,
        epoch_reward_cap: u128,
    ) -> Self {
        Self {
            claims: LookupMap::new(b"mint-claims".to_vec()),
            bootstrap_cap,
            bootstrap_minted: 0,
            global_reward_cap,
            rewards_minted: 0,
            epoch_length_ns,
            epoch_reward_cap,
            last_epoch: 0,
            epoch_minted: 0,
        }
    }

    pub fn apply(&mut self, claim_id: &str, claim: &Claim, current_epoch: u64) -> bool {
        validate_id(claim_id);
        require!(claim.amount.0 > 0, "Amount must be positive");
        let key = claim_id.to_owned();
        if let Some(previous) = self.claims.get(&key) {
            require!(previous == *claim, "Claim payload mismatch");
            return false;
        }
        let amount = claim.amount.0;
        if let Some(epoch) = claim.epoch {
            require!(epoch.0 == current_epoch, "Reward epoch is not current");
            if self.last_epoch != current_epoch {
                self.last_epoch = current_epoch;
                self.epoch_minted = 0;
            }
            require!(
                amount <= self.epoch_reward_cap - self.epoch_minted,
                "Epoch reward cap exceeded"
            );
            require!(
                amount <= self.global_reward_cap - self.rewards_minted,
                "Global reward cap exceeded"
            );
            self.epoch_minted += amount;
            self.rewards_minted += amount;
        } else {
            require!(
                amount <= self.bootstrap_cap - self.bootstrap_minted,
                "Bootstrap cap exceeded"
            );
            self.bootstrap_minted += amount;
        }
        self.claims.insert(&key, claim);
        true
    }
}

pub fn validate_id(id: &str) {
    require!(
        !id.is_empty()
            && id.len() <= 96
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_:.".contains(&byte)),
        "Invalid operation ID"
    );
}
