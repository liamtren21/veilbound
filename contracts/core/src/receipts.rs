use crate::ledger::valid_id;
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::{env, near, require, AccountId};

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RewardReceipt {
    pub network: String,
    pub contract: AccountId,
    pub ruleset: String,
    pub account_id: AccountId,
    pub run_id: String,
    pub encounter_id: String,
    pub sequence: U64,
    pub claim_id: String,
    pub amount: U128,
    pub epoch: U64,
    pub expires_at_ns: U64,
}

impl RewardReceipt {
    pub fn verify(&self, ruleset: &str, signer: &[u8; 32], signature: Base64VecU8) {
        require!(
            self.network == "testnet"
                && self.contract == env::current_account_id()
                && self.ruleset == ruleset,
            "Wrong receipt domain"
        );
        require!(
            self.expires_at_ns.0 >= env::block_timestamp(),
            "Reward receipt expired"
        );
        require!(
            valid_id(&self.run_id)
                && valid_id(&self.encounter_id)
                && valid_id(&self.claim_id)
                && self.amount.0 > 0,
            "Invalid reward payload"
        );
        let signature: [u8; 64] = signature
            .0
            .try_into()
            .expect("Expected 64-byte Ed25519 signature");
        require!(
            env::ed25519_verify(&signature, self.message().as_bytes(), signer),
            "Invalid reward signature"
        );
    }

    fn message(&self) -> String {
        [
            "VEILBOUND_REWARD_V1",
            &self.network,
            self.contract.as_str(),
            &self.ruleset,
            self.account_id.as_str(),
            &self.run_id,
            &self.encounter_id,
            &self.sequence.0.to_string(),
            &self.claim_id,
            &self.amount.0.to_string(),
            &self.epoch.0.to_string(),
            &self.expires_at_ns.0.to_string(),
        ]
        .join("\n")
    }
}
