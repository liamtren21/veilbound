use crate::{Core, CoreExt};
use crate::factory::{Artifact, ArtifactStatus};
use crate::ledger::valid_id;
use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_sdk::{near, env, require, assert_one_yocto, AccountId};
use near_sdk::json_types::{U128, U64};
use near_sdk::collections::LookupMap;

#[near(serializers = [borsh, json])]
#[derive(PartialEq)]
pub struct ArtifactWithdrawal {
    pub holder: AccountId,
    pub epoch: U64,
    pub copper: U128,
    pub item_ids: Vec<String>,
    pub amounts: Vec<U128>,
}

fn withdrawals() -> LookupMap<(String, String), ArtifactWithdrawal> {
    LookupMap::new(b"artifact-withdrawal-v1".to_vec())
}

#[near(serializers = [borsh, json])]
pub struct Policy {
    pub operator: AccountId,
    pub recipe_id: String,
    pub epoch: U64,
    pub max_jobs: U64,
    pub completed: U64,
    pub copper_budget: U128,
    pub spent: U128,
    pub expires_at_ns: U64,
}

#[near]
impl Core {
    pub fn get_artifact_job_receipt(&self, token_id: String, operation_id: String) -> Option<String> {
        self.artifact_job_receipts.get(&(token_id, operation_id))
    }

    pub fn get_artifact_withdrawal(&self, token_id: String, operation_id: String) -> Option<ArtifactWithdrawal> {
        withdrawals().get(&(token_id, operation_id))
    }

    #[payable]
    pub fn withdraw_artifact(&mut self, token_id: String, expected_epoch: U64, operation_id: String,
        copper: U128, item_ids: Vec<String>, amounts: Vec<U128>) -> ArtifactWithdrawal {
        assert_one_yocto();
        require!(valid_id(&operation_id), "Invalid operation ID");
        self.assert_artifact_holder(&token_id);
        let holder = env::predecessor_account_id();
        let receipt = ArtifactWithdrawal { holder: holder.clone(), epoch: expected_epoch, copper, item_ids, amounts };
        let key = (token_id.clone(), operation_id);
        if let Some(previous) = withdrawals().get(&key) {
            require!(previous == receipt, "Artifact withdrawal payload mismatch");
            return previous;
        }
        let mut artifact = self.available_artifact(&token_id);
        self.assert_shop_orders_closed(&artifact);
        require!(artifact.epoch == expected_epoch, "Artifact epoch changed");
        require!(holder != artifact.vault_id && (copper.0 > 0 || !receipt.item_ids.is_empty()), "Invalid withdrawal");
        let mut source = self.get_balance(artifact.vault_id.clone());
        let mut target = self.get_balance(holder.clone());
        require!(source.available.0 >= copper.0, "Insufficient available artifact Copper");
        if receipt.item_ids.is_empty() {
            require!(receipt.amounts.is_empty(), "Invalid item batch");
        } else {
            self.check_item_batch(&artifact.vault_id, &receipt.item_ids, &receipt.amounts);
        }
        self.charge_storage(&holder, 800 + 450 * receipt.item_ids.len() as u128);
        if !receipt.item_ids.is_empty() {
            self.lock_starter_items(&artifact.vault_id, &receipt.item_ids, &receipt.amounts);
            self.claim_starter_items(&artifact.vault_id, &holder, &receipt.item_ids, &receipt.amounts);
        }
        source.available.0 -= copper.0;
        target.available.0 = target.available.0.checked_add(copper.0).expect("Balance overflow");
        self.balances.insert(&artifact.vault_id, &source);
        self.balances.insert(&holder, &target);
        self.artifact_policies.remove(&token_id);
        artifact.epoch.0 = artifact.epoch.0.checked_add(1).expect("Epoch overflow");
        self.artifacts.insert(&token_id, &artifact);
        withdrawals().insert(&key, &receipt);
        receipt
    }

    fn available_artifact(&self, token_id: &String) -> Artifact {
        self.assert_not_rented(token_id);
        require!(!self.paused && !self.nft_sales.contains_key(token_id), "Artifact unavailable");
        let artifact = self.artifacts.get(token_id).expect("Unknown artifact");
        require!(artifact.kind != crate::factory::ArtifactKind::CompanionBond, "Companion has no vault");
        require!(artifact.status == ArtifactStatus::Ready && !artifact.transfer_pending, "Artifact locked");
        artifact
    }
    fn assert_artifact_holder(&self, token_id: &String) {
        require!(self.nft.nft_token(token_id.clone()).expect("Unknown NFT").owner_id ==
            env::predecessor_account_id(), "Only current holder");
    }
}

#[near]
impl Core {
    pub fn get_artifact_policy(&self, token_id: String) -> Option<Policy> {
        self.artifact_policies.get(&token_id)
    }
    #[payable]
    pub fn fund_artifact(&mut self, token_id: String, copper: U128, item_ids: Vec<String>, amounts: Vec<U128>) {
        assert_one_yocto();
        let artifact = self.available_artifact(&token_id);
        self.assert_artifact_holder(&token_id);
        let owner = env::predecessor_account_id();
        require!(owner != artifact.vault_id, "Self funding");
        require!(copper.0 > 0 || !item_ids.is_empty(), "Empty funding");
        let mut source = self.get_balance(owner.clone());
        let mut target = self.get_balance(artifact.vault_id.clone());
        require!(source.available.0 >= copper.0, "Insufficient Copper");
        self.charge_storage(&owner, 1000);
        if !item_ids.is_empty() {
            self.check_item_batch(&owner, &item_ids, &amounts);
            self.lock_starter_items(&owner, &item_ids, &amounts);
            self.claim_starter_items(&owner, &artifact.vault_id, &item_ids, &amounts);
        } else { require!(amounts.is_empty(), "Invalid item batch"); }
        source.available.0 -= copper.0;
        target.available.0 = target.available.0.checked_add(copper.0).expect("Balance overflow");
        self.balances.insert(&owner, &source);
        self.balances.insert(&artifact.vault_id, &target);
    }
    #[payable]
    pub fn set_artifact_policy(&mut self, token_id: String, operator: AccountId, recipe_id: String,
        max_jobs: U64, copper_budget: U128, expires_at_ns: U64) {
        assert_one_yocto();
        let mut artifact = self.available_artifact(&token_id);
        self.assert_artifact_holder(&token_id);
        require!(self.recipes.contains_key(&recipe_id) && max_jobs.0 > 0 &&
            expires_at_ns.0 > env::block_timestamp(), "Invalid policy");
        self.charge_storage(&env::predecessor_account_id(), 700);
        artifact.epoch.0 = artifact.epoch.0.checked_add(1).expect("Epoch overflow");
        self.artifacts.insert(&token_id, &artifact);
        self.artifact_policies.insert(&token_id, &Policy { operator, recipe_id, epoch: artifact.epoch,
            max_jobs, completed: U64(0), copper_budget, spent: U128(0), expires_at_ns });
    }
    #[payable]
    pub fn revoke_artifact_policy(&mut self, token_id: String) {
        assert_one_yocto();
        self.assert_artifact_holder(&token_id);
        self.artifact_policies.remove(&token_id);
    }
    #[payable]
    pub fn execute_artifact_craft(&mut self, token_id: String, operation_id: String,
        expected_epoch: U64, expected_recipe_id: String) {
        assert_one_yocto();
        require!(valid_id(&operation_id), "Invalid operation");
        let artifact = self.available_artifact(&token_id);
        let mut policy = self.artifact_policies.get(&token_id).expect("No policy");
        require!(artifact.epoch == expected_epoch && policy.recipe_id == expected_recipe_id,
            "Queued policy changed");
        require!(policy.operator == env::predecessor_account_id() && policy.epoch == artifact.epoch &&
            env::block_timestamp() < policy.expires_at_ns.0, "Policy unauthorized or expired");
        let key = (token_id.clone(), operation_id);
        if let Some(prior) = self.artifact_job_receipts.get(&key) {
            require!(prior == policy.recipe_id, "Job conflict");
            return;
        }
        let recipe = self.recipes.get(&policy.recipe_id).expect("Unknown recipe");
        let spent = policy.spent.0.checked_add(recipe.copper_cost.0).expect("Budget overflow");
        require!(policy.completed.0 < policy.max_jobs.0 && spent <= policy.copper_budget.0, "Policy budget exhausted");
        let mut balance = self.get_balance(artifact.vault_id.clone());
        require!(balance.available.0 >= recipe.copper_cost.0, "Insufficient artifact Copper");
        let holder = self.nft.nft_token(token_id.clone()).expect("Unknown NFT").owner_id;
        self.charge_storage(&holder, 900);
        self.craft_item_balance(&artifact.vault_id, &recipe.input_ids, &recipe.input_amounts,
            &recipe.output_id, recipe.output_amount);
        balance.available.0 -= recipe.copper_cost.0;
        self.balances.insert(&artifact.vault_id, &balance);
        let mut treasury = self.get_balance(self.owner_id.clone());
        treasury.available.0 = treasury.available.0.checked_add(recipe.copper_cost.0).expect("Fee overflow");
        self.balances.insert(&self.owner_id, &treasury);
        policy.completed.0 += 1;
        policy.spent.0 = spent;
        self.artifact_job_receipts.insert(&key, &policy.recipe_id);
        self.artifact_policies.insert(&token_id, &policy);
    }
}
