use crate::{Core, CoreExt};
use crate::ledger::valid_id;
use crate::factory::ArtifactStatus;
use near_sdk::{near, env, require, assert_one_yocto, AccountId};
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::collections::LookupMap;
use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;

#[near(serializers = [borsh, json])]
pub struct EvolutionRecipe {
    pub item_ids: Vec<String>,
    pub amounts: Vec<U128>,
    pub copper_cost: U128,
    pub media: String,
    pub media_hash: Base64VecU8,
}

fn evolution_recipes() -> LookupMap<u8, EvolutionRecipe> {
    LookupMap::new(b"evolution-recipe-v1".to_vec())
}

#[near(serializers = [borsh, json])]
#[derive(PartialEq)]
pub struct Entry {
    pub player: AccountId,
    pub run_id: String,
    pub ruleset: String,
    pub achievement: String,
    pub recorded_at_ns: U64,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
pub struct ChronicleReceipt {
    pub network: String,
    pub contract: AccountId,
    pub ruleset: String,
    pub account_id: AccountId,
    pub run_id: String,
    pub token_id: String,
    pub artifact_epoch: U64,
    pub entry_id: String,
    pub achievement: String,
    pub expires_at_ns: U64,
}

fn signed_milestones() -> LookupMap<(String, String, String), String> {
    LookupMap::new(b"signed-chronicle-milestone-v1".to_vec())
}

#[near]
impl Core {
    #[payable]
    pub fn record_signed_chronicle(&mut self, receipt: ChronicleReceipt, signature: Base64VecU8) -> Entry {
        assert_one_yocto();
        require!(receipt.network == "testnet" && receipt.contract == env::current_account_id() &&
            receipt.ruleset == self.ruleset, "Wrong Chronicle domain");
        require!([&receipt.run_id, &receipt.token_id, &receipt.entry_id, &receipt.achievement]
            .iter().all(|id| valid_id(id)), "Invalid Chronicle receipt");
        let message = [
            "VEILBOUND_CHRONICLE_V1", &receipt.network, receipt.contract.as_str(), &receipt.ruleset,
            receipt.account_id.as_str(), &receipt.run_id, &receipt.token_id, &receipt.artifact_epoch.0.to_string(),
            &receipt.entry_id, &receipt.achievement, &receipt.expires_at_ns.0.to_string(),
        ].join("\n");
        let signature: [u8; 64] = signature.0.try_into().expect("Expected 64-byte Ed25519 signature");
        require!(env::ed25519_verify(&signature, message.as_bytes(), &self.receipt_signer), "Invalid Chronicle signature");
        let key = (receipt.token_id.clone(), receipt.entry_id.clone());
        let milestone_key = (receipt.token_id.clone(), receipt.run_id.clone(), receipt.achievement.clone());
        if let Some(previous) = signed_milestones().get(&milestone_key) {
            require!(previous == receipt.entry_id, "Chronicle milestone already recorded");
            let entry = self.chronicles.get(&key).expect("Missing Chronicle entry");
            require!(entry.player == receipt.account_id && entry.ruleset == receipt.ruleset &&
                entry.run_id == receipt.run_id && entry.achievement == receipt.achievement, "Chronicle receipt conflict");
            return entry;
        }
        require!(!self.paused && env::block_timestamp() < receipt.expires_at_ns.0, "Chronicle receipt unavailable");
        require!(!self.chronicles.contains_key(&key), "Chronicle entry ID already used");
        let artifact = self.artifacts.get(&receipt.token_id).expect("Unknown artifact");
        require!(artifact.status == ArtifactStatus::Ready && !artifact.transfer_pending &&
            artifact.epoch == receipt.artifact_epoch && !self.nft_sales.contains_key(&receipt.token_id),
            "Artifact locked or epoch changed");
        require!(self.nft.nft_token(receipt.token_id).expect("Unknown NFT").owner_id == receipt.account_id,
            "Chronicle holder changed");
        self.charge_storage(&env::predecessor_account_id(), 1600);
        let entry = Entry { player: receipt.account_id, run_id: receipt.run_id, ruleset: receipt.ruleset,
            achievement: receipt.achievement, recorded_at_ns: U64(env::block_timestamp()) };
        self.chronicles.insert(&key, &entry);
        signed_milestones().insert(&milestone_key, &receipt.entry_id);
        entry
    }

    pub fn register_evolution_recipe(&mut self, stage: u8, recipe: EvolutionRecipe) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        require!((1..=2).contains(&stage) && !evolution_recipes().contains_key(&stage), "Evolution recipe exists or invalid");
        require!(!recipe.item_ids.is_empty() && recipe.item_ids.len() <= 16 && recipe.item_ids.len() == recipe.amounts.len() && recipe.copper_cost.0 > 0, "Invalid evolution cost");
        let mut seen = std::collections::BTreeSet::new();
        for (id, amount) in recipe.item_ids.iter().zip(&recipe.amounts) {
            require!(valid_id(id) && seen.insert(id) && amount.0 > 0 && self.mt_supply(id.clone()).is_some(), "Invalid evolution input");
        }
        require!((recipe.media.starts_with("https://") || recipe.media.starts_with("ipfs://")) && recipe.media.len() <= 512 && recipe.media_hash.0.len() == 32, "Invalid evolution media");
        self.charge_storage(&self.owner_id.clone(), 1600 + 160 * recipe.item_ids.len() as u128);
        evolution_recipes().insert(&stage, &recipe);
    }

    pub fn get_evolution_recipe(&self, stage: u8) -> Option<EvolutionRecipe> {
        evolution_recipes().get(&stage)
    }
    pub fn get_chronicle_entry(&self, token_id: String, entry_id: String) -> Option<Entry> {
        self.chronicles.get(&(token_id, entry_id))
    }
    pub fn get_artifact_stage(&self, token_id: String) -> u8 {
        self.artifact_stages.get(&token_id).unwrap_or(0)
    }
    pub fn record_chronicle(&mut self, token_id: String, entry_id: String, player: AccountId,
        run_id: String, ruleset: String, achievement: String) {
        require!(env::predecessor_account_id() == self.owner_id, "Only achievement issuer");
        require!(valid_id(&entry_id) && valid_id(&run_id) && ruleset == self.ruleset && valid_id(&achievement), "Invalid chronicle");
        let artifact = self.artifacts.get(&token_id).expect("Unknown artifact");
        require!(artifact.status == ArtifactStatus::Ready && !artifact.transfer_pending &&
            !self.nft_sales.contains_key(&token_id), "Artifact locked");
        let key = (token_id, entry_id);
        if let Some(prior) = self.chronicles.get(&key) {
            require!(prior.player == player && prior.run_id == run_id && prior.ruleset == ruleset &&
                prior.achievement == achievement, "Chronicle conflict");
            return;
        }
        self.charge_storage(&self.owner_id.clone(), 800);
        self.chronicles.insert(&key, &Entry { player, run_id, ruleset, achievement,
            recorded_at_ns: U64(env::block_timestamp()) });
    }
    #[payable]
    pub fn evolve_artifact_media(&mut self, token_id: String, stage: u8, required_entry_id: String,
        media: String, media_hash: Base64VecU8) {
        assert_one_yocto();
        self.assert_not_rented(&token_id);
        let holder = env::predecessor_account_id();
        require!(self.nft.nft_token(token_id.clone()).expect("Unknown NFT").owner_id == holder, "Only current holder");
        require!(!self.paused, "Core paused");
        let artifact = self.artifacts.get(&token_id).expect("Unknown artifact");
        require!(artifact.kind != crate::factory::ArtifactKind::CompanionBond, "Companion evolution unavailable");
        require!(artifact.status == ArtifactStatus::Ready && !artifact.transfer_pending &&
            !self.nft_sales.contains_key(&token_id), "Artifact locked");
        let recipe = evolution_recipes().get(&stage).expect("Evolution recipe unavailable");
        require!(recipe.media == media && recipe.media_hash == media_hash, "Evolution media changed");
        let current = self.get_artifact_stage(token_id.clone());
        let milestone = self.chronicles.get(&(token_id.clone(), required_entry_id)).expect("Missing verified milestone");
        let required = if stage == 1 { "region-3-clear" } else { "five-region-clear" };
        require!(milestone.achievement == required && milestone.ruleset == self.ruleset, "Wrong evolution milestone");
        if current == stage { return; }
        require!(stage > 0 && stage <= 2 && stage == current + 1, "Invalid stage");
        require!((media.starts_with("https://") || media.starts_with("ipfs://")) && media.len() <= 512 &&
            media_hash.0.len() == 32, "Invalid media");
        self.check_item_batch(&holder, &recipe.item_ids, &recipe.amounts);
        let mut balance = self.get_balance(holder.clone());
        require!(balance.available.0 >= recipe.copper_cost.0, "Insufficient evolution Copper");
        self.charge_storage(&holder, 1000);
        self.burn_evolution_items(&holder, &recipe.item_ids, &recipe.amounts);
        if holder != self.owner_id {
            balance.available.0 -= recipe.copper_cost.0;
            let mut treasury = self.get_balance(self.owner_id.clone());
            treasury.available.0 = treasury.available.0.checked_add(recipe.copper_cost.0).expect("Fee overflow");
            self.balances.insert(&holder, &balance);
            self.balances.insert(&self.owner_id, &treasury);
        }
        let metadata_map = self.nft.token_metadata_by_id.as_mut().expect("Metadata unavailable");
        let mut metadata = metadata_map.get(&token_id).expect("Unknown NFT metadata");
        metadata.media = Some(media);
        metadata.media_hash = Some(media_hash);
        metadata_map.insert(&token_id, &metadata);
        self.artifact_stages.insert(&token_id, &stage);
    }
}
