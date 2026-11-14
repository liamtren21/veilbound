use crate::ledger::valid_id;
use crate::{Core, CoreExt};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Gas, Promise, PromiseResult,
};
use std::collections::BTreeSet;

const MAX_BATCH: usize = 16;
type Approval = (AccountId, u64);

#[near(serializers = [borsh])]
pub(crate) struct Items {
    catalog: LookupMap<String, ItemDefinition>,
    balances: LookupMap<(AccountId, String), ItemBalance>,
    bootstrap: LookupMap<String, ItemGrant>,
    reservations: LookupMap<(AccountId, String), ItemReservation>,
}

impl Items {
    pub(crate) fn new() -> Self {
        Self {
            catalog: LookupMap::new(b"item-catalog".to_vec()),
            balances: LookupMap::new(b"item-balances".to_vec()),
            bootstrap: LookupMap::new(b"item-bootstrap".to_vec()),
            reservations: LookupMap::new(b"item-reservations".to_vec()),
        }
    }
}

#[near(serializers = [borsh, json])]
pub struct ItemDefinition {
    name: String,
    version: U64,
    supply: U128,
    bootstrap_cap: U128,
    bootstrap_minted: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Default)]
pub struct ItemBalance {
    available: U128,
    reserved: U128,
    pending: U128,
}

#[near(serializers = [json])]
pub struct MultiToken {
    token_id: String,
    owner_id: Option<AccountId>,
}

#[near(serializers = [borsh])]
#[derive(PartialEq)]
struct ItemGrant {
    receiver_id: AccountId,
    token_id: String,
    amount: U128,
}

#[near(serializers = [borsh, json])]
pub struct ItemReservation {
    token_ids: Vec<String>,
    amounts: Vec<U128>,
    consumed: Option<Vec<U128>>,
}

#[allow(dead_code)]
#[ext_contract(item_receiver)]
trait ItemReceiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Vec<U128>;
}

#[near]
impl Core {
    pub fn register_item(
        &mut self,
        token_id: String,
        name: String,
        version: U64,
        bootstrap_cap: U128,
    ) {
        self.assert_item_operator();
        require!(
            valid_id(&token_id) && !name.is_empty() && name.len() <= 80 && version.0 > 0,
            "Invalid item metadata"
        );
        require!(
            !self.items.catalog.contains_key(&token_id),
            "Item already exists"
        );
        self.items.catalog.insert(
            &token_id,
            &ItemDefinition {
                name,
                version,
                supply: U128(0),
                bootstrap_cap,
                bootstrap_minted: U128(0),
            },
        );
    }

    pub fn get_item_definition(&self, token_id: String) -> Option<ItemDefinition> {
        self.items.catalog.get(&token_id)
    }

    pub fn bootstrap_item(
        &mut self,
        claim_id: String,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
    ) {
        self.assert_item_operator();
        require!(valid_id(&claim_id) && amount.0 > 0, "Invalid item grant");
        let grant = ItemGrant {
            receiver_id,
            token_id,
            amount,
        };
        if let Some(prior) = self.items.bootstrap.get(&claim_id) {
            require!(prior == grant, "Item grant payload mismatch");
            return;
        }
        let mut item = self
            .items
            .catalog
            .get(&grant.token_id)
            .expect("Unknown item");
        require!(
            amount.0 <= item.bootstrap_cap.0 - item.bootstrap_minted.0,
            "Item bootstrap cap exceeded"
        );
        item.supply.0 += amount.0;
        item.bootstrap_minted.0 += amount.0;
        let mut balance = self.get_item_balance(grant.receiver_id.clone(), grant.token_id.clone());
        balance.available.0 += amount.0;
        self.items.balances.insert(
            &(grant.receiver_id.clone(), grant.token_id.clone()),
            &balance,
        );
        self.items.catalog.insert(&grant.token_id, &item);
        self.items.bootstrap.insert(&claim_id, &grant);
        event(
            "mt_mint",
            json!({ "owner_id": grant.receiver_id, "token_ids": [grant.token_id], "amounts": [amount], "memo": "bootstrap" }),
        );
    }

    pub fn get_item_balance(&self, account_id: AccountId, token_id: String) -> ItemBalance {
        self.items
            .balances
            .get(&(account_id, token_id))
            .unwrap_or_default()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<MultiToken>> {
        self.check_view_batch(&token_ids);
        token_ids
            .into_iter()
            .map(|token_id| {
                self.items
                    .catalog
                    .contains_key(&token_id)
                    .then_some(MultiToken {
                        token_id,
                        owner_id: None,
                    })
            })
            .collect()
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        let balance = self.get_item_balance(account_id, token_id);
        U128(balance.available.0 + balance.reserved.0 + balance.pending.0)
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        self.check_view_batch(&token_ids);
        token_ids
            .into_iter()
            .map(|token| self.mt_balance_of(account_id.clone(), token))
            .collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        self.items.catalog.get(&token_id).map(|item| item.supply)
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        self.check_view_batch(&token_ids);
        token_ids
            .into_iter()
            .map(|token| self.mt_supply(token))
            .collect()
    }

    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<Approval>,
        memo: Option<String>,
    ) {
        require!(approval.is_none(), "Item approvals are disabled");
        self.mt_batch_transfer(receiver_id, vec![token_id], vec![amount], None, memo);
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<Approval>>>,
        memo: Option<String>,
    ) {
        let sender = self.check_item_transfer(&receiver_id, &token_ids, &amounts, approvals);
        self.move_items(&sender, &receiver_id, &token_ids, &amounts, false);
        transfer_event(&sender, &receiver_id, &token_ids, &amounts, memo);
    }

    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<Approval>,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        require!(approval.is_none(), "Item approvals are disabled");
        self.mt_batch_transfer_call(receiver_id, vec![token_id], vec![amount], None, memo, msg)
    }

    #[payable]
    pub fn mt_batch_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<Approval>>>,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        require!(
            env::prepaid_gas() >= Gas::from_tgas(80),
            "Attach at least 80 Tgas"
        );
        require!(msg.len() <= 2048, "Item transfer message too large");
        let sender = self.check_item_transfer(&receiver_id, &token_ids, &amounts, approvals);
        self.move_items(&sender, &receiver_id, &token_ids, &amounts, true);
        transfer_event(&sender, &receiver_id, &token_ids, &amounts, memo);
        item_receiver::ext(receiver_id.clone())
            .with_static_gas(Gas::from_tgas(25))
            .mt_on_transfer(
                sender.clone(),
                vec![sender.clone(); token_ids.len()],
                token_ids.clone(),
                amounts.clone(),
                msg,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(30))
                    .mt_resolve_transfer(sender, receiver_id, token_ids, amounts),
            )
    }

    #[private]
    pub fn mt_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
    ) -> Vec<U128> {
        let unused = match env::promise_result(0) {
            PromiseResult::Successful(bytes) if bytes.len() <= 1024 => {
                serde_json::from_slice::<Vec<U128>>(&bytes)
                    .ok()
                    .filter(|amounts| amounts.len() == token_ids.len())
            }
            _ => None,
        }
        .unwrap_or_else(|| amounts.clone());

        let mut used = Vec::with_capacity(amounts.len());
        let mut refunded_tokens = Vec::new();
        let mut refunded_amounts = Vec::new();
        for ((token_id, amount), unused) in token_ids.iter().zip(amounts).zip(unused) {
            let refund = unused.0.min(amount.0);
            let retained = amount.0 - refund;
            let receiver_key = (receiver_id.clone(), token_id.clone());
            let mut receiver_balance = self
                .items
                .balances
                .get(&receiver_key)
                .expect("Missing receiver");
            receiver_balance.pending.0 -= amount.0;
            receiver_balance.available.0 += retained;
            self.items.balances.insert(&receiver_key, &receiver_balance);
            if refund > 0 {
                let sender_key = (sender_id.clone(), token_id.clone());
                let mut sender_balance = self
                    .items
                    .balances
                    .get(&sender_key)
                    .expect("Missing sender");
                sender_balance.available.0 += refund;
                self.items.balances.insert(&sender_key, &sender_balance);
                refunded_tokens.push(token_id.clone());
                refunded_amounts.push(U128(refund));
            }
            used.push(U128(retained));
        }
        if !refunded_tokens.is_empty() {
            transfer_event(
                &receiver_id,
                &sender_id,
                &refunded_tokens,
                &refunded_amounts,
                Some("transfer refund".into()),
            );
        }
        used
    }

    #[payable]
    pub fn reserve_items(
        &mut self,
        reservation_id: String,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
    ) -> ItemReservation {
        assert_one_yocto();
        require!(valid_id(&reservation_id), "Invalid reservation ID");
        let account = env::predecessor_account_id();
        let key = (account.clone(), reservation_id);
        if let Some(reservation) = self.items.reservations.get(&key) {
            require!(
                reservation.token_ids == token_ids && reservation.amounts == amounts,
                "Reservation payload mismatch"
            );
            return reservation;
        }
        require!(!self.paused, "Core paused");
        self.check_item_batch(&account, &token_ids, &amounts);
        self.charge_storage(&account, 256 + 120 * token_ids.len() as u128);
        for (token_id, amount) in token_ids.iter().zip(&amounts) {
            let key = (account.clone(), token_id.clone());
            let mut balance = self.items.balances.get(&key).expect("Missing item balance");
            balance.available.0 -= amount.0;
            balance.reserved.0 += amount.0;
            self.items.balances.insert(&key, &balance);
        }
        let reservation = ItemReservation {
            token_ids,
            amounts,
            consumed: None,
        };
        self.items.reservations.insert(&key, &reservation);
        reservation
    }

    pub fn get_item_reservation(
        &self,
        account_id: AccountId,
        reservation_id: String,
    ) -> Option<ItemReservation> {
        self.items.reservations.get(&(account_id, reservation_id))
    }

    pub fn settle_item_use(
        &mut self,
        account_id: AccountId,
        reservation_id: String,
        consumed: Vec<U128>,
    ) -> ItemReservation {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only item operator"
        );
        require!(self.get_run_item_reservation(account_id.clone(), reservation_id.clone()).is_none(),
            "Run items require signed closure");
        self.settle_reserved_items(account_id, reservation_id, consumed)
    }
    fn assert_item_operator(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only item operator"
        );
        require!(!self.paused, "Core paused");
    }

    pub(crate) fn credit_material_reward(&mut self, account: &AccountId, id: &String, quantity: U128) {
        let mut definition = self.items.catalog.get(id).expect("Unknown material reward");
        let key = (account.clone(), id.clone());
        let mut balance = self.items.balances.get(&key).unwrap_or_default();
        balance.available.0 = balance.available.0.checked_add(quantity.0).expect("Balance overflow");
        definition.supply.0 = definition.supply.0.checked_add(quantity.0).expect("Supply overflow");
        self.items.balances.insert(&key, &balance);
        self.items.catalog.insert(id, &definition);
        event("mt_mint", json!({"owner_id": account, "token_ids": [id], "amounts": [quantity], "memo": "expedition bank"}));
    }

    pub(crate) fn release_market_items(&mut self, account: &AccountId, id: &String, amount: U128) {
        let key = (account.clone(), id.clone());
        let mut balance = self.items.balances.get(&key).expect("Missing reserved item");
        balance.reserved.0 -= amount.0;
        balance.available.0 = balance.available.0.checked_add(amount.0).expect("Balance overflow");
        self.items.balances.insert(&key, &balance);
    }

    pub(crate) fn burn_evolution_items(&mut self, account: &AccountId, ids: &[String], amounts: &[U128]) {
        self.check_item_batch(account, ids, amounts);
        for (id, amount) in ids.iter().zip(amounts) {
            let key = (account.clone(), id.clone());
            let mut balance = self.items.balances.get(&key).expect("Missing evolution item");
            let mut definition = self.items.catalog.get(id).expect("Unknown evolution item");
            balance.available.0 -= amount.0;
            definition.supply.0 -= amount.0;
            self.items.balances.insert(&key, &balance);
            self.items.catalog.insert(id, &definition);
        }
        event("mt_burn", json!({"owner_id": account, "token_ids": ids, "amounts": amounts, "memo": "chronicle evolution"}));
    }

    pub(crate) fn complete_craft_order_items(&mut self, buyer: &AccountId,
        recipe: &crate::craft::Recipe) {
        // Output is crafted for the buyer from its reserved inputs in the same receipt.
        for (id, amount) in recipe.input_ids.iter().zip(&recipe.input_amounts) {
            self.release_market_items(buyer, id, *amount);
        }
        self.craft_item_balance(buyer, &recipe.input_ids, &recipe.input_amounts, &recipe.output_id, recipe.output_amount);
    }

    pub(crate) fn craft_item_balance(&mut self, account: &AccountId, inputs: &[String], amounts: &[U128],
        output: &String, quantity: U128) {
        self.check_item_batch(account, inputs, amounts);
        let mut definition = self.items.catalog.get(output).expect("Unknown craft output");
        let output_key = (account.clone(), output.clone());
        let mut result = self.items.balances.get(&output_key).unwrap_or_default();
        result.available.0 = result.available.0.checked_add(quantity.0).expect("Output overflow");
        definition.supply.0 = definition.supply.0.checked_add(quantity.0).expect("Supply overflow");
        for (id, amount) in inputs.iter().zip(amounts) {
            let key = (account.clone(), id.clone());
            let mut balance = self.items.balances.get(&key).expect("Missing input");
            let mut input = self.items.catalog.get(id).expect("Unknown input");
            balance.available.0 -= amount.0;
            input.supply.0 -= amount.0;
            self.items.balances.insert(&key, &balance);
            self.items.catalog.insert(id, &input);
        }
        self.items.balances.insert(&output_key, &result);
        self.items.catalog.insert(output, &definition);
        event("mt_burn", json!({"owner_id": account, "token_ids": inputs, "amounts": amounts, "memo": "craft"}));
        event("mt_mint", json!({"owner_id": account, "token_ids": [output], "amounts": [quantity], "memo": "craft"}));
    }

    pub(crate) fn lock_starter_items(&mut self, account: &AccountId, ids: &[String], amounts: &[U128]) {
        for (id, amount) in ids.iter().zip(amounts) {
            let key = (account.clone(), id.clone());
            let mut balance = self.items.balances.get(&key).expect("Missing starter item");
            balance.available.0 -= amount.0;
            balance.reserved.0 += amount.0;
            self.items.balances.insert(&key, &balance);
        }
    }

    pub(crate) fn claim_starter_items(&mut self, source: &AccountId, receiver: &AccountId, ids: &[String], amounts: &[U128]) {
        for (id, amount) in ids.iter().zip(amounts) {
            let source_key = (source.clone(), id.clone());
            let receiver_key = (receiver.clone(), id.clone());
            let mut source_balance = self.items.balances.get(&source_key).expect("Missing starter item");
            let mut receiver_balance = self.items.balances.get(&receiver_key).unwrap_or_default();
            source_balance.reserved.0 -= amount.0;
            receiver_balance.available.0 += amount.0;
            self.items.balances.insert(&source_key, &source_balance);
            self.items.balances.insert(&receiver_key, &receiver_balance);
        }
        transfer_event(source, receiver, ids, amounts, Some("starter claim".into()));
    }

    pub(crate) fn burn_starter_items(&mut self, account: &AccountId, ids: &[String], amounts: &[U128]) {
        let mut burned = Vec::new();
        let mut quantities = Vec::new();
        for (id, amount) in ids.iter().zip(amounts).filter(|(_, amount)| amount.0 > 0) {
            let key = (account.clone(), id.clone());
            let mut balance = self.items.balances.get(&key).expect("Missing starter item");
            let mut definition = self.items.catalog.get(id).expect("Unknown starter item");
            balance.reserved.0 -= amount.0;
            definition.supply.0 -= amount.0;
            self.items.balances.insert(&key, &balance);
            self.items.catalog.insert(id, &definition);
            burned.push(id);
            quantities.push(amount);
        }
        if !burned.is_empty() {
            event("mt_burn", json!({"owner_id": account, "token_ids": burned, "amounts": quantities, "memo": "starter run"}));
        }
    }
    fn check_view_batch(&self, token_ids: &[String]) {
        require!(token_ids.len() <= 100, "Item query limit exceeded");
    }

    pub(crate) fn check_item_batch(&self, account: &AccountId, token_ids: &[String], amounts: &[U128]) {
        require!(
            !token_ids.is_empty()
                && token_ids.len() == amounts.len()
                && token_ids.len() <= MAX_BATCH,
            "Invalid item batch"
        );
        let mut seen = BTreeSet::new();
        for (token_id, amount) in token_ids.iter().zip(amounts) {
            require!(
                valid_id(token_id) && amount.0 > 0 && seen.insert(token_id),
                "Invalid or duplicate item"
            );
            require!(
                self.get_item_balance(account.clone(), token_id.clone())
                    .available
                    .0
                    >= amount.0,
                "Insufficient available item balance"
            );
        }
    }

    fn check_item_transfer(
        &self,
        receiver_id: &AccountId,
        token_ids: &[String],
        amounts: &[U128],
        approvals: Option<Vec<Option<Approval>>>,
    ) -> AccountId {
        assert_one_yocto();
        require!(!self.paused, "Core paused");
        require!(
            approvals
                .is_none_or(|entries| entries.len() == token_ids.len()
                    && entries.iter().all(Option::is_none)),
            "Item approvals are disabled"
        );
        let sender = env::predecessor_account_id();
        require!(&sender != receiver_id, "Self transfer is not permitted");
        self.check_item_batch(&sender, token_ids, amounts);
        sender
    }

    fn move_items(
        &mut self,
        sender: &AccountId,
        receiver: &AccountId,
        token_ids: &[String],
        amounts: &[U128],
        provisional: bool,
    ) {
        for (token_id, amount) in token_ids.iter().zip(amounts) {
            let sender_key = (sender.clone(), token_id.clone());
            let receiver_key = (receiver.clone(), token_id.clone());
            let mut sender_balance = self
                .items
                .balances
                .get(&sender_key)
                .expect("Missing sender");
            let mut receiver_balance =
                self.items.balances.get(&receiver_key).unwrap_or_else(|| {
                    self.charge_storage(sender, 300);
                    ItemBalance::default()
                });
            sender_balance.available.0 -= amount.0;
            if provisional {
                receiver_balance.pending.0 += amount.0;
            } else {
                receiver_balance.available.0 += amount.0;
            }
            self.items.balances.insert(&sender_key, &sender_balance);
            self.items.balances.insert(&receiver_key, &receiver_balance);
        }
    }
}

fn event(name: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({
            "standard": "nep245", "version": "1.0.0", "event": name, "data": [data],
        })
    ));
}

fn transfer_event(
    sender: &AccountId,
    receiver: &AccountId,
    token_ids: &[String],
    amounts: &[U128],
    memo: Option<String>,
) {
    event(
        "mt_transfer",
        json!({
            "old_owner_id": sender, "new_owner_id": receiver, "token_ids": token_ids, "amounts": amounts, "memo": memo,
        }),
    );
}

impl Core {
    pub(crate) fn settle_reserved_items(&mut self, account_id: AccountId, reservation_id: String, consumed: Vec<U128>) -> ItemReservation {
        let key = (account_id.clone(), reservation_id);
        let mut reservation = self
            .items
            .reservations
            .get(&key)
            .expect("Unknown reservation");
        if let Some(previous) = &reservation.consumed {
            require!(*previous == consumed, "Item use payload mismatch");
            return reservation;
        }
        require!(
            reservation.amounts.len() == consumed.len()
                && reservation
                    .amounts
                    .iter()
                    .zip(&consumed)
                    .all(|(reserved, used)| used.0 <= reserved.0),
            "Invalid item use amounts"
        );
        let mut burned_tokens = Vec::new();
        let mut burned_amounts = Vec::new();
        for ((token_id, reserved), used) in reservation
            .token_ids
            .iter()
            .zip(&reservation.amounts)
            .zip(&consumed)
        {
            let key = (account_id.clone(), token_id.clone());
            let mut balance = self.items.balances.get(&key).expect("Missing item balance");
            balance.reserved.0 -= reserved.0;
            balance.available.0 += reserved.0 - used.0;
            self.items.balances.insert(&key, &balance);
            if used.0 > 0 {
                let mut item = self.items.catalog.get(token_id).expect("Unknown item");
                item.supply.0 -= used.0;
                self.items.catalog.insert(token_id, &item);
                burned_tokens.push(token_id);
                burned_amounts.push(used);
            }
        }
        reservation.consumed = Some(consumed.clone());
        self.items.reservations.insert(&key, &reservation);
        if !burned_tokens.is_empty() {
            event(
                "mt_burn",
                json!({ "owner_id": account_id, "token_ids": burned_tokens, "amounts": burned_amounts }),
            );
        }
        reservation
    }

}
