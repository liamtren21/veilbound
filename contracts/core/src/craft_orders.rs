use crate::{Core, CoreExt};
use crate::ledger::valid_id;
use near_sdk::{near, env, require, assert_one_yocto, AccountId};
use near_sdk::json_types::{U128, U64};

#[near(serializers = [borsh, json])]
pub struct CraftOrder {
    pub recipe_id: String,
    pub worker: AccountId,
    pub wage: U128,
    pub deadline: U64,
    pub status: String,
}
#[near]
impl Core {
    pub fn get_craft_order(&self, buyer: AccountId, order_id: String) -> Option<CraftOrder> {
        self.craft_orders.get(&(buyer, order_id))
    }
    #[payable]
    pub fn place_craft_order(&mut self, order_id: String, recipe_id: String,
        worker: AccountId, wage: U128, deadline: U64) {
        assert_one_yocto();
        require!(!self.paused && valid_id(&order_id), "Invalid craft order");
        require!(deadline.0 > env::block_timestamp() && wage.0 > 0, "Invalid craft deadline or wage");
        let buyer = env::predecessor_account_id();
        require!(buyer != worker, "Self craft order");
        let key = (buyer.clone(), order_id);
        if let Some(prior) = self.craft_orders.get(&key) {
            require!(prior.recipe_id == recipe_id && prior.worker == worker && prior.wage == wage && prior.deadline == deadline,
                "Craft order conflict");
            return;
        }
        let recipe = self.recipes.get(&recipe_id).expect("Unknown recipe");
        self.check_item_batch(&buyer, &recipe.input_ids, &recipe.input_amounts);
        let cost = recipe.copper_cost.0.checked_add(wage.0).expect("Escrow overflow");
        let mut balance = self.get_balance(buyer.clone());
        require!(balance.available.0 >= cost, "Insufficient Copper");
        self.charge_storage(&buyer, 1000);
        self.lock_starter_items(&buyer, &recipe.input_ids, &recipe.input_amounts);
        balance.available.0 -= cost;
        balance.reserved.0 = balance.reserved.0.checked_add(cost).expect("Reserve overflow");
        self.balances.insert(&buyer, &balance);
        self.craft_orders.insert(&key, &CraftOrder { recipe_id, worker, wage, deadline, status: "open".into() });
    }
    #[payable]
    pub fn fulfill_craft_order(&mut self, buyer: AccountId, order_id: String) {
        assert_one_yocto();
        require!(!self.paused, "Core paused");
        let key = (buyer.clone(), order_id);
        let mut order = self.craft_orders.get(&key).expect("Unknown craft order");
        require!(env::predecessor_account_id() == order.worker, "Only assigned worker");
        if order.status == "paid" { return; }
        require!(order.status == "open" && env::block_timestamp() < order.deadline.0, "Craft order unavailable");
        let recipe = self.recipes.get(&order.recipe_id).expect("Unknown recipe");
        self.charge_storage(&order.worker, 320);
        self.complete_craft_order_items(&buyer, &recipe);
        let mut balance = self.get_balance(buyer.clone());
        balance.reserved.0 -= recipe.copper_cost.0 + order.wage.0;
        self.balances.insert(&buyer, &balance);
        let mut worker = self.get_balance(order.worker.clone());
        worker.available.0 = worker.available.0.checked_add(order.wage.0).expect("Wage overflow");
        self.balances.insert(&order.worker, &worker);
        let mut treasury = self.get_balance(self.owner_id.clone());
        treasury.available.0 = treasury.available.0.checked_add(recipe.copper_cost.0).expect("Fee overflow");
        self.balances.insert(&self.owner_id, &treasury);
        order.status = "paid".into();
        self.craft_orders.insert(&key, &order);
    }
    #[payable]
    pub fn cancel_craft_order(&mut self, order_id: String) {
        assert_one_yocto();
        let buyer = env::predecessor_account_id();
        let key = (buyer.clone(), order_id);
        let mut order = self.craft_orders.get(&key).expect("Unknown craft order");
        if order.status == "cancelled" { return; }
        require!(order.status == "open", "Craft order closed");
        let recipe = self.recipes.get(&order.recipe_id).expect("Unknown recipe");
        for (id, amount) in recipe.input_ids.iter().zip(&recipe.input_amounts) {
            self.release_market_items(&buyer, id, *amount);
        }
        let refund = recipe.copper_cost.0 + order.wage.0;
        let mut balance = self.get_balance(buyer.clone());
        balance.reserved.0 -= refund;
        balance.available.0 = balance.available.0.checked_add(refund).expect("Refund overflow");
        self.balances.insert(&buyer, &balance);
        order.status = "cancelled".into();
        self.craft_orders.insert(&key, &order);
    }
}
