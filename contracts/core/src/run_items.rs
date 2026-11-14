use crate::ledger::valid_id;
use crate::{Core, CoreExt};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::{assert_one_yocto, env, near, require, AccountId};
use std::collections::BTreeSet;

const MAX_RESERVE_LIFETIME_NS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RunItemReceipt {
    pub network: String,
    pub contract: AccountId,
    pub ruleset: String,
    pub account_id: AccountId,
    pub run_id: String,
    pub reservation_id: String,
    pub token_ids: Vec<String>,
    pub amounts: Vec<U128>,
    pub reserve_sequence: U64,
    pub expires_at_ns: U64,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
pub struct RunItemCloseReceipt {
    pub reservation: RunItemReceipt,
    pub consumed: Vec<U128>,
    pub close_sequence: U64,
}

#[near(serializers = [borsh, json])]
pub struct RunItemReservation {
    pub reservation: RunItemReceipt,
    pub consumed: Option<Vec<U128>>,
    pub close_sequence: Option<U64>,
}

fn reservations() -> LookupMap<(AccountId, String), RunItemReservation> {
    LookupMap::new(b"run-item-bindings-v1".to_vec())
}

impl RunItemReceipt {
    fn fields(&self) -> Vec<String> {
        vec![
            self.network.clone(),
            self.contract.to_string(),
            self.ruleset.clone(),
            self.account_id.to_string(),
            self.run_id.clone(),
            self.reservation_id.clone(),
            near_sdk::serde_json::to_string(&self.token_ids).expect("Item ID encoding failed"),
            near_sdk::serde_json::to_string(&self.amounts).expect("Item amount encoding failed"),
            self.reserve_sequence.0.to_string(),
            self.expires_at_ns.0.to_string(),
        ]
    }

    fn verify_domain(&self, core: &Core) {
        require!(
            self.network == "testnet"
                && self.contract == env::current_account_id()
                && self.ruleset == core.ruleset,
            "Wrong run item receipt domain"
        );
        require!(
            valid_id(&self.run_id) && valid_id(&self.reservation_id),
            "Invalid run item binding"
        );
        require!(
            !self.token_ids.is_empty()
                && self.token_ids.len() <= 16
                && self.token_ids.len() == self.amounts.len(),
            "Invalid run item batch"
        );
        let mut unique = BTreeSet::new();
        for (id, amount) in self.token_ids.iter().zip(&self.amounts) {
            require!(
                valid_id(id) && unique.insert(id) && amount.0 > 0,
                "Invalid run item input"
            );
        }
    }
}

fn verify_signature(
    prefix: &str,
    fields: Vec<String>,
    signature: Base64VecU8,
    public_key: &[u8; 32],
) {
    let signature: [u8; 64] = signature
        .0
        .try_into()
        .expect("Expected 64-byte Ed25519 signature");
    let message = std::iter::once(prefix.to_owned())
        .chain(fields)
        .collect::<Vec<_>>()
        .join("\n");
    require!(
        env::ed25519_verify(&signature, message.as_bytes(), public_key),
        "Invalid run item signature"
    );
}

#[near]
impl Core {
    pub fn get_run_item_reservation(
        &self,
        account_id: AccountId,
        reservation_id: String,
    ) -> Option<RunItemReservation> {
        reservations().get(&(account_id, reservation_id))
    }

    #[payable]
    pub fn reserve_run_items(
        &mut self,
        receipt: RunItemReceipt,
        signature: Base64VecU8,
    ) -> RunItemReservation {
        assert_one_yocto();
        require!(
            env::predecessor_account_id() == receipt.account_id,
            "Only run item holder"
        );
        receipt.verify_domain(self);
        verify_signature(
            "VEILBOUND_RUN_ITEMS_RESERVE_V1",
            receipt.fields(),
            signature,
            &self.receipt_signer,
        );
        let key = (receipt.account_id.clone(), receipt.reservation_id.clone());
        if let Some(existing) = reservations().get(&key) {
            require!(
                existing.reservation == receipt,
                "Run item reservation conflict"
            );
            return existing;
        }
        require!(!self.paused, "Core paused");
        let now = env::block_timestamp();
        require!(
            receipt.expires_at_ns.0 > now
                && receipt.expires_at_ns.0 - now <= MAX_RESERVE_LIFETIME_NS,
            "Run item reservation expired or too distant"
        );
        require!(
            self.get_item_reservation(key.0.clone(), key.1.clone())
                .is_none(),
            "Item reservation ID already used"
        );
        self.charge_storage(
            &receipt.account_id,
            800 + 160 * receipt.token_ids.len() as u128,
        );
        self.reserve_items(
            receipt.reservation_id.clone(),
            receipt.token_ids.clone(),
            receipt.amounts.clone(),
        );
        let record = RunItemReservation {
            reservation: receipt,
            consumed: None,
            close_sequence: None,
        };
        reservations().insert(&key, &record);
        record
    }

    pub fn close_run_items(
        &mut self,
        receipt: RunItemCloseReceipt,
        signature: Base64VecU8,
    ) -> RunItemReservation {
        receipt.reservation.verify_domain(self);
        require!(
            receipt.consumed.len() == receipt.reservation.amounts.len()
                && receipt
                    .consumed
                    .iter()
                    .zip(&receipt.reservation.amounts)
                    .all(|(used, reserved)| used.0 <= reserved.0),
            "Invalid final item consumption"
        );
        require!(
            receipt.close_sequence.0 > receipt.reservation.reserve_sequence.0,
            "Invalid run close sequence"
        );
        let mut fields = receipt.reservation.fields();
        fields.push(
            near_sdk::serde_json::to_string(&receipt.consumed)
                .expect("Consumption encoding failed"),
        );
        fields.push(receipt.close_sequence.0.to_string());
        verify_signature(
            "VEILBOUND_RUN_ITEMS_CLOSE_V1",
            fields,
            signature,
            &self.receipt_signer,
        );
        let key = (
            receipt.reservation.account_id.clone(),
            receipt.reservation.reservation_id.clone(),
        );
        let mut record = reservations()
            .get(&key)
            .expect("Unknown run item reservation");
        require!(
            record.reservation == receipt.reservation,
            "Run item closure binding mismatch"
        );
        if let Some(consumed) = &record.consumed {
            require!(
                *consumed == receipt.consumed
                    && record.close_sequence == Some(receipt.close_sequence),
                "Run item closure conflict"
            );
            return record;
        }
        self.settle_reserved_items(key.0.clone(), key.1.clone(), receipt.consumed.clone());
        record.consumed = Some(receipt.consumed);
        record.close_sequence = Some(receipt.close_sequence);
        reservations().insert(&key, &record);
        record
    }
}
