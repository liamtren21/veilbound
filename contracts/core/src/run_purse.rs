use crate::ledger::valid_id;
use crate::{Core, CoreExt};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, Gas, Promise, PromiseError, PromiseOrValue};

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PurseReserve {
    pub network: String,
    pub contract: AccountId,
    pub ruleset: String,
    pub account_id: AccountId,
    pub run_id: String,
    pub amount: U128,
    pub expires_at_ns: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PurseClose {
    pub reservation: PurseReserve,
    pub sequence: U64,
    pub returned: U128,
    pub spent: U128,
    pub lost: U128,
}

#[near(serializers = [borsh, json])]
pub struct PurseRecord {
    pub reservation: PurseReserve,
    pub close: Option<PurseClose>,
    pub settled: bool,
}

type PurseKey = (AccountId, String);

fn purses() -> LookupMap<PurseKey, PurseRecord> {
    LookupMap::new(b"run-purse-v1".to_vec())
}

impl PurseReserve {
    fn key(&self) -> PurseKey { (self.account_id.clone(), self.run_id.clone()) }

    fn message(&self, prefix: &str) -> String {
        [prefix, &self.network, self.contract.as_str(), &self.ruleset, self.account_id.as_str(),
            &self.run_id, &self.amount.0.to_string(), &self.expires_at_ns.0.to_string()].join("\n")
    }
}

fn verify(message: String, signature: Base64VecU8, signer: &[u8; 32]) {
    let signature: [u8; 64] = signature.0.try_into().expect("Expected 64-byte signature");
    require!(env::ed25519_verify(&signature, message.as_bytes(), signer), "Invalid purse signature");
}

#[near]
impl Core {
    pub fn get_run_purse(&self, account_id: AccountId, run_id: String) -> Option<PurseRecord> {
        purses().get(&(account_id, run_id))
    }

    #[payable]
    pub fn reserve_run_purse(&mut self, receipt: PurseReserve, signature: Base64VecU8) -> PurseRecord {
        assert_one_yocto();
        require!(env::predecessor_account_id() == receipt.account_id, "Only purse holder");
        let mut records = purses();
        let key = receipt.key();
        if let Some(existing) = records.get(&key) {
            require!(existing.reservation == receipt, "Purse reserve conflict");
            return existing;
        }
        require!(!self.paused, "Core paused");
        require!(receipt.network == "testnet" && receipt.contract == env::current_account_id() &&
            receipt.ruleset == self.ruleset && valid_id(&receipt.run_id), "Wrong purse domain");
        require!(receipt.amount.0 > 0 && receipt.amount.0 <= 4000 && receipt.amount.0 % 100 == 0 &&
            receipt.expires_at_ns.0 >= env::block_timestamp(), "Invalid purse amount or expiry");
        verify(receipt.message("VEILBOUND_RUN_PURSE_RESERVE_V1"), signature, &self.receipt_signer);
        let mut balance = self.get_balance(receipt.account_id.clone());
        require!(balance.available.0 >= receipt.amount.0, "Insufficient available Copper");
        self.charge_operation_storage(&receipt.account_id);
        balance.available.0 -= receipt.amount.0;
        balance.reserved.0 += receipt.amount.0;
        self.balances.insert(&receipt.account_id, &balance);
        let record = PurseRecord { reservation: receipt, close: None, settled: false };
        records.insert(&key, &record);
        record
    }

    pub fn close_run_purse(&mut self, receipt: PurseClose, signature: Base64VecU8) -> PromiseOrValue<PurseRecord> {
        let mut records = purses();
        let key = receipt.reservation.key();
        let mut record = records.get(&key).expect("Unknown run purse");
        require!(record.reservation == receipt.reservation, "Purse reserve mismatch");
        if let Some(prior) = &record.close {
            require!(prior == &receipt, "Purse close conflict");
            if record.settled { return PromiseOrValue::Value(record); }
        } else {
            require!(receipt.sequence.0 > 0 && receipt.returned.0.checked_add(receipt.spent.0)
                .and_then(|sum| sum.checked_add(receipt.lost.0)) == Some(record.reservation.amount.0),
                "Purse conservation failed");
            let message = format!("{}\n{}\n{}\n{}\n{}",
                receipt.reservation.message("VEILBOUND_RUN_PURSE_CLOSE_V1"), receipt.sequence.0,
                receipt.returned.0, receipt.spent.0, receipt.lost.0);
            verify(message, signature, &self.receipt_signer);
            record.close = Some(receipt.clone());
            records.insert(&key, &record);
        }
        if receipt.lost.0 == 0 {
            return PromiseOrValue::Value(self.finish_run_purse(key, record));
        }
        crate::settlement::assert_dispatch_gas();
        let operation_id = env::sha256_array(format!("run-purse\n{}\n{}", key.0, key.1).as_bytes())
            .iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let args = near_sdk::serde_json::json!({"operation_id": operation_id, "amount": receipt.lost});
        PromiseOrValue::Promise(Promise::new(self.copper_id.clone()).function_call(
            "burn_custody".into(), args.to_string().into_bytes(), near_sdk::NearToken::from_yoctonear(0),
            Gas::from_tgas(20),
        ).then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(20))
            .on_run_purse_burn(key.0, key.1)))
    }

    #[private]
    pub fn on_run_purse_burn(&mut self, account_id: AccountId, run_id: String,
        #[callback_result] result: Result<U128, PromiseError>) -> PurseRecord {
        let key = (account_id, run_id);
        let record = purses().get(&key).expect("Unknown run purse");
        if record.settled { return record; }
        let Ok(burned) = result else { return record; };
        require!(record.close.as_ref().is_some_and(|close| close.lost == burned), "Purse burn mismatch");
        self.finish_run_purse(key, record)
    }

    fn finish_run_purse(&mut self, key: PurseKey, mut record: PurseRecord) -> PurseRecord {
        let close = record.close.as_ref().expect("Missing purse close");
        let mut balance = self.get_balance(key.0.clone());
        balance.reserved.0 -= record.reservation.amount.0;
        balance.available.0 += close.returned.0;
        self.balances.insert(&key.0, &balance);
        let mut treasury = self.get_balance(self.owner_id.clone());
        treasury.available.0 += close.spent.0;
        self.balances.insert(&self.owner_id, &treasury);
        self.total_allocated -= close.lost.0;
        record.settled = true;
        purses().insert(&key, &record);
        record
    }
}

