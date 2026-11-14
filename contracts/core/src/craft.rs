use crate::{Core, CoreExt};
use crate::ledger::valid_id;
use near_sdk::{near, env, require, assert_one_yocto, AccountId};
use near_sdk::json_types::U128;
use std::collections::BTreeSet;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Recipe {
    pub input_ids: Vec<String>,
    pub input_amounts: Vec<U128>,
    pub output_id: String,
    pub output_amount: U128,
    pub copper_cost: U128,
}

#[near]
impl Core {
    pub fn register_recipe(&mut self, recipe_id: String, recipe: Recipe) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        require!(valid_id(&recipe_id) && !self.recipes.contains_key(&recipe_id), "Recipe exists or invalid");
        require!(!recipe.input_ids.is_empty() && recipe.input_ids.len() <= 16 &&
            recipe.input_ids.len() == recipe.input_amounts.len(), "Invalid recipe");
        require!(valid_id(&recipe.output_id) && recipe.output_amount.0 > 0, "Invalid output");
        let mut ids = BTreeSet::new();
        for (id, quantity) in recipe.input_ids.iter().zip(&recipe.input_amounts) {
            require!(valid_id(id) && ids.insert(id) && *id != recipe.output_id && quantity.0 > 0, "Invalid recipe input");
        }
        self.recipes.insert(&recipe_id, &recipe);
    }

    pub fn get_recipe(&self, recipe_id: String) -> Option<Recipe> {
        self.recipes.get(&recipe_id)
    }

    #[payable]
    pub fn craft_item(&mut self, operation_id: String, recipe_id: String) -> bool {
        assert_one_yocto();
        require!(valid_id(&operation_id), "Invalid operation");
        let account = env::predecessor_account_id();
        let key = (account.clone(), operation_id);
        if let Some(previous) = self.craft_receipts.get(&key) {
            require!(previous == recipe_id, "Craft operation conflict");
            return true;
        }
        require!(!self.paused, "Core paused");
        let recipe = self.recipes.get(&recipe_id).expect("Unknown recipe");
        let mut balance = self.get_balance(account.clone());
        require!(balance.available.0 >= recipe.copper_cost.0, "Insufficient Copper");
        self.charge_storage(&account, 1000);
        self.craft_item_balance(&account, &recipe.input_ids, &recipe.input_amounts, &recipe.output_id, recipe.output_amount);
        if account != self.owner_id {
            let mut treasury = self.get_balance(self.owner_id.clone());
            balance.available.0 -= recipe.copper_cost.0;
            treasury.available.0 = treasury.available.0.checked_add(recipe.copper_cost.0).expect("Fee overflow");
            self.balances.insert(&account, &balance);
            self.balances.insert(&self.owner_id, &treasury);
        }
        self.craft_receipts.insert(&key, &recipe_id);
        true
    }

    pub fn get_craft_receipt(&self, account_id: AccountId, operation_id: String) -> Option<String> {
        self.craft_receipts.get(&(account_id, operation_id))
    }
}
