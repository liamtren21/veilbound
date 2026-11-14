use crate::ledger::valid_id;
use crate::{Core, CoreExt};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::{assert_one_yocto, env, near, require, AccountId};

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MaterialRewardReceipt {
    pub network: String,
    pub contract: AccountId,
    pub ruleset: String,
    pub account_id: AccountId,
    pub run_id: String,
    pub encounter_id: String,
    pub sequence: U64,
    pub entitlement_id: String,
    pub token_id: String,
    pub amount: U128,
    pub expires_at_ns: U64,
}

fn receipts() -> LookupMap<String, MaterialRewardReceipt> {
    LookupMap::new(b"material-reward-receipts-v1".to_vec())
}

fn budgets() -> LookupMap<String, (u128, u128)> {
    LookupMap::new(b"material-reward-budgets-v1".to_vec())
}

#[near]
impl Core {
    #[payable]
    pub fn configure_material_reward_budget(&mut self, token_id: String, maximum: U128) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        require!(valid_id(&token_id) && maximum.0 > 0, "Invalid material budget");
        let mut budget = budgets();
        require!(budget.get(&token_id).is_none(), "Material budget already configured");
        budget.insert(&token_id, &(maximum.0, 0));
    }

    pub fn get_material_reward_budget(&self, token_id: String) -> Option<(U128, U128)> {
        budgets().get(&token_id).map(|(maximum, issued)| (U128(maximum), U128(issued)))
    }

    pub fn get_material_reward(&self, entitlement_id: String) -> Option<MaterialRewardReceipt> {
        receipts().get(&entitlement_id)
    }

    #[payable]
    pub fn claim_material_reward(&mut self, receipt: MaterialRewardReceipt, signature: Base64VecU8) -> MaterialRewardReceipt {
        assert_one_yocto();
        require!(env::predecessor_account_id() == receipt.account_id, "Only material beneficiary");
        let mut claims = receipts();
        if let Some(previous) = claims.get(&receipt.entitlement_id) {
            require!(previous == receipt, "Material receipt conflict");
            return previous;
        }
        require!(!self.paused, "Core paused");
        require!(receipt.network == "testnet" && receipt.contract == env::current_account_id() &&
            receipt.ruleset == self.ruleset, "Wrong material receipt domain");
        require!(receipt.expires_at_ns.0 >= env::block_timestamp() && receipt.sequence.0 > 0 &&
            receipt.amount.0 > 0, "Invalid material receipt amount or timing");
        require!([&receipt.run_id, &receipt.encounter_id, &receipt.entitlement_id, &receipt.token_id]
            .iter().all(|id| valid_id(id)), "Invalid material receipt identifier");
        let signature: [u8; 64] = signature.0.try_into().expect("Expected 64-byte Ed25519 signature");
        let message = ["VEILBOUND_MATERIAL_REWARD_V1", &receipt.network, receipt.contract.as_str(), &receipt.ruleset,
            receipt.account_id.as_str(), &receipt.run_id, &receipt.encounter_id, &receipt.sequence.0.to_string(),
            &receipt.entitlement_id, &receipt.token_id, &receipt.amount.0.to_string(), &receipt.expires_at_ns.0.to_string()].join("\n");
        require!(env::ed25519_verify(&signature, message.as_bytes(), &self.receipt_signer), "Invalid material signature");
        let mut budget = budgets();
        let (maximum, issued) = budget.get(&receipt.token_id).expect("Material budget unavailable");
        require!(receipt.amount.0 <= maximum - issued, "Material budget exhausted");
        self.charge_operation_storage(&receipt.account_id);
        self.credit_material_reward(&receipt.account_id, &receipt.token_id, receipt.amount);
        budget.insert(&receipt.token_id, &(maximum, issued + receipt.amount.0));
        claims.insert(&receipt.entitlement_id, &receipt);
        receipt
    }
}

