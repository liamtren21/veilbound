use crate::{Core, CoreExt};
use crate::ledger::valid_id;
use near_sdk::{near, env, require, assert_one_yocto, AccountId};
use near_sdk::json_types::{U128, U64};

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq)]
pub enum Side { Buy, Sell }

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Order {
    pub side: Side,
    pub token_id: String,
    pub quantity: U128,
    pub remaining: U128,
    pub price: U128,
    pub expires_at_ns: U64,
    pub version: U64,
    pub cancelled: bool,
}

#[near]
impl Core {
    pub fn get_market_order(&self, owner: AccountId, order_id: String) -> Option<Order> {
        self.market_orders.get(&(owner, order_id))
    }

    #[payable]
    pub fn place_market_order(&mut self, order_id: String, side: Side, token_id: String,
        quantity: U128, price: U128, expires_at_ns: U64) -> Order {
        assert_one_yocto();
        let actor = env::predecessor_account_id();
        self.place_order_for(actor.clone(), &actor, order_id, side, token_id, quantity, price, expires_at_ns)
    }

    pub(crate) fn place_order_for(&mut self, owner: AccountId, storage_payer: &AccountId,
        order_id: String, side: Side, token_id: String, quantity: U128, price: U128, expires_at_ns: U64) -> Order {
        require!(!self.paused, "Core paused");
        require!(valid_id(&order_id) && valid_id(&token_id) && quantity.0 > 0 && price.0 > 0, "Invalid order");
        require!(expires_at_ns.0 > env::block_timestamp(), "Order expired");
        let key = (owner.clone(), order_id);
        if let Some(existing) = self.market_orders.get(&key) {
            require!(existing.side == side && existing.token_id == token_id &&
                existing.quantity == quantity && existing.price == price &&
                existing.expires_at_ns == expires_at_ns, "Order ID conflict");
            return existing;
        }
        let cost = quantity.0.checked_mul(price.0).expect("Order overflow");
        self.charge_storage(storage_payer, 800);
        match side {
            Side::Buy => {
                let mut balance = self.get_balance(owner.clone());
                require!(balance.available.0 >= cost, "Insufficient Copper");
                balance.available.0 -= cost;
                balance.reserved.0 = balance.reserved.0.checked_add(cost).expect("Reserve overflow");
                self.balances.insert(&owner, &balance);
            }
            Side::Sell => {
                self.check_item_batch(&owner, &[token_id.clone()], &[quantity]);
                self.lock_starter_items(&owner, &[token_id.clone()], &[quantity]);
            }
        }
        let order = Order { side, token_id, quantity, remaining: quantity, price, expires_at_ns,
            version: U64(0), cancelled: false };
        self.market_orders.insert(&key, &order);
        order
    }

    #[payable]
    pub fn fill_market_order(&mut self, owner: AccountId, order_id: String, quantity: U128,
        expected_version: U64) -> Order {
        assert_one_yocto();
        require!(!self.paused, "Core paused");
        let actor = env::predecessor_account_id();
        require!(actor != owner, "Self fill");
        self.assert_market_actor(&owner, &actor);
        let key = (owner.clone(), order_id);
        let mut order = self.market_orders.get(&key).expect("Unknown order");
        require!(!order.cancelled && order.version == expected_version &&
            order.expires_at_ns.0 > env::block_timestamp(), "Order unavailable");
        require!(quantity.0 > 0 && quantity.0 <= order.remaining.0, "Invalid fill");
        let cost = quantity.0.checked_mul(order.price.0).expect("Fill overflow");
        let (buyer, seller) = if order.side == Side::Buy {
            self.check_item_batch(&actor, &[order.token_id.clone()], &[quantity]);
            self.lock_starter_items(&actor, &[order.token_id.clone()], &[quantity]);
            (owner.clone(), actor.clone())
        } else {
            (actor.clone(), owner.clone())
        };
        let mut buyer_balance = self.get_balance(buyer.clone());
        if order.side == Side::Buy {
            require!(buyer_balance.reserved.0 >= cost, "Insufficient escrow");
            buyer_balance.reserved.0 -= cost;
        } else {
            require!(buyer_balance.available.0 >= cost, "Insufficient Copper");
            buyer_balance.available.0 -= cost;
        }
        let fee = cost / 100 * 3 + ((cost % 100) * 3 + 99) / 100;
        require!(fee < cost, "Fill below minimum after fee");
        self.charge_storage(&actor, 320);
        self.claim_starter_items(&seller, &buyer, &[order.token_id.clone()], &[quantity]);
        self.balances.insert(&buyer, &buyer_balance);
        let mut seller_balance = self.get_balance(seller.clone());
        seller_balance.available.0 = seller_balance.available.0.checked_add(cost - fee).expect("Balance overflow");
        self.balances.insert(&seller, &seller_balance);
        let mut treasury = self.get_balance(self.owner_id.clone());
        treasury.available.0 = treasury.available.0.checked_add(fee).expect("Fee overflow");
        self.balances.insert(&self.owner_id, &treasury);
        order.remaining.0 -= quantity.0;
        if order.remaining.0 == 0 { self.close_shop_order_count(&owner); }
        order.version.0 += 1;
        self.market_orders.insert(&key, &order);
        order
    }

    #[payable]
    pub fn cancel_market_order(&mut self, order_id: String) -> Order {
        assert_one_yocto();
        self.cancel_order_for(env::predecessor_account_id(), order_id)
    }

    pub(crate) fn cancel_order_for(&mut self, owner: AccountId, order_id: String) -> Order {
        let key = (owner.clone(), order_id);
        let mut order = self.market_orders.get(&key).expect("Unknown order");
        if order.cancelled { return order; }
        if order.side == Side::Buy {
            let refund = order.remaining.0.checked_mul(order.price.0).expect("Refund overflow");
            let mut balance = self.get_balance(owner.clone());
            balance.reserved.0 -= refund;
            balance.available.0 = balance.available.0.checked_add(refund).expect("Balance overflow");
            self.balances.insert(&owner, &balance);
        } else if order.remaining.0 > 0 {
            self.release_market_items(&owner, &order.token_id, order.remaining);
        }
        if order.remaining.0 > 0 { self.close_shop_order_count(&owner); }
        order.cancelled = true;
        order.version.0 += 1;
        self.market_orders.insert(&key, &order);
        order
    }
}
