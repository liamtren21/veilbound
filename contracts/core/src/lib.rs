use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, PanicOnDefault, PromiseOrValue};

mod factory;
mod items;
mod ledger;
mod nft;
mod receipts;
mod settlement;
mod starter;
mod market;
mod craft;
mod sale;
mod craft_orders;
mod artifact_jobs;
mod chronicle;
mod field;
mod run_items;
mod shop;
mod material_rewards;
mod run_purse;
mod guild;
mod rental;

use factory::Artifact;
use ledger::{Balance, Deposit, Operation, OperationKind, Status};
use near_contract_standards::non_fungible_token::NonFungibleToken;
use receipts::RewardReceipt;

#[near(serializers = [json])]
pub struct RewardConfiguration {
    pub receipt_signer: Base64VecU8,
    pub ruleset: String,
    pub copper_id: AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Core {
    owner_id: AccountId,
    copper_id: AccountId,
    receipt_signer: [u8; 32],
    ruleset: String,
    paused: bool,
    balances: LookupMap<AccountId, Balance>,
    storage_credit: LookupMap<AccountId, u128>,
    operations: LookupMap<(OperationKind, AccountId, String), Operation>,
    total_allocated: u128,
    nft: NonFungibleToken,
    items: items::Items,
    starter: starter::StarterPool,
    artifacts: LookupMap<String, Artifact>,
    vault_code_hash: Option<[u8; 32]>,
    market_orders: LookupMap<(AccountId, String), market::Order>,
    recipes: LookupMap<String, craft::Recipe>,
    craft_receipts: LookupMap<(AccountId, String), String>,
    nft_sales: LookupMap<String, sale::Sale>,
    sale_credits: LookupMap<AccountId, u128>,
    sale_pending: LookupMap<AccountId, u128>,
    craft_orders: LookupMap<(AccountId, String), craft_orders::CraftOrder>,
    artifact_policies: LookupMap<String, artifact_jobs::Policy>,
    artifact_job_receipts: LookupMap<(String, String), String>,
    chronicles: LookupMap<(String, String), chronicle::Entry>,
    artifact_stages: LookupMap<String, u8>,
}

#[near]
impl Core {
    pub fn get_reward_config(&self) -> RewardConfiguration {
        RewardConfiguration {
            receipt_signer: Base64VecU8(self.receipt_signer.to_vec()),
            ruleset: self.ruleset.clone(), copper_id: self.copper_id.clone(),
        }
    }
    #[init]
    pub fn new(
        owner_id: AccountId,
        copper_id: AccountId,
        receipt_signer: Base64VecU8,
        ruleset: String,
    ) -> Self {
        require!(ledger::valid_id(&ruleset), "Invalid ruleset");
        require!(
            owner_id != copper_id && copper_id != env::current_account_id(),
            "Invalid Copper account"
        );
        Self {
            owner_id: owner_id.clone(),
            copper_id,
            ruleset,
            receipt_signer: receipt_signer
                .0
                .try_into()
                .expect("Expected 32-byte Ed25519 public key"),
            paused: true,
            balances: LookupMap::new(b"balances".to_vec()),
            storage_credit: LookupMap::new(b"storage".to_vec()),
            operations: LookupMap::new(b"operations".to_vec()),
            total_allocated: 0,
            nft: NonFungibleToken::new(
                b"nft-owner".to_vec(),
                owner_id,
                Some(b"nft-metadata".to_vec()),
                Some(b"nft-enumeration".to_vec()),
                None::<Vec<u8>>,
            ),
            items: items::Items::new(),
            starter: starter::StarterPool::new(),
            artifacts: LookupMap::new(b"artifact".to_vec()),
            vault_code_hash: None,
            market_orders: LookupMap::new(b"market-orders".to_vec()),
            recipes: LookupMap::new(b"recipes".to_vec()),
            craft_receipts: LookupMap::new(b"craft-receipts".to_vec()),
            nft_sales: LookupMap::new(b"nft-sales".to_vec()),
            sale_credits: LookupMap::new(b"sale-credits".to_vec()),
            sale_pending: LookupMap::new(b"sale-pending".to_vec()),
            craft_orders: LookupMap::new(b"craft-orders".to_vec()),
            artifact_policies: LookupMap::new(b"artifact-policies".to_vec()),
            artifact_job_receipts: LookupMap::new(b"artifact-job".to_vec()),
            chronicles: LookupMap::new(b"chronicles".to_vec()),
            artifact_stages: LookupMap::new(b"artifact-stages".to_vec()),
        }
    }

    pub fn set_paused(&mut self, paused: bool) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        self.paused = paused;
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn upgrade(&mut self, wasm: Base64VecU8) -> near_sdk::Promise {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        require!(self.paused, "Pause Core before upgrade");
        require!(wasm.0.len() >= 8 && wasm.0[..8] == [0, 97, 115, 109, 1, 0, 0, 0], "Invalid WASM");
        near_sdk::Promise::new(env::current_account_id()).deploy_contract(wasm.0)
    }

    #[payable]
    pub fn fund_storage(&mut self, account_id: Option<AccountId>) -> U128 {
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        let previous = self.storage_credit.get(&account_id);
        let payment = env::attached_deposit().as_yoctonear();
        let registration = if previous.is_none() {
            Self::storage_cost(160)
        } else {
            0
        };
        require!(payment > registration, "Insufficient storage deposit");
        let balance = previous
            .unwrap_or(0)
            .checked_add(payment - registration)
            .expect("Storage credit overflow");
        self.storage_credit.insert(&account_id, &balance);
        U128(balance)
    }

    pub fn get_balance(&self, account_id: AccountId) -> Balance {
        self.balances.get(&account_id).unwrap_or_default()
    }

    pub fn get_total_allocated(&self) -> U128 {
        U128(self.total_allocated)
    }

    pub fn get_storage_credit(&self, account_id: AccountId) -> U128 {
        U128(self.storage_credit.get(&account_id).unwrap_or(0))
    }

    pub fn get_operation(
        &self,
        operation_id: String,
        account_id: AccountId,
        kind: OperationKind,
    ) -> Option<Operation> {
        self.operations.get(&(kind, account_id, operation_id))
    }

    #[payable]
    pub fn withdraw(&mut self, operation_id: String, amount: U128) -> PromiseOrValue<Operation> {
        assert_one_yocto();
        require!(
            ledger::valid_id(&operation_id) && amount.0 > 0,
            "Invalid withdrawal"
        );
        let account = env::predecessor_account_id();
        let key = (OperationKind::Withdraw, account.clone(), operation_id);
        if let Some(op) = self.operations.get(&key) {
            require!(op.amount == amount, "Operation payload mismatch");
            return PromiseOrValue::Value(op);
        }
        require!(!self.paused, "Core paused");
        settlement::assert_dispatch_gas();
        self.charge_operation_storage(&account);
        let mut balance = self.get_balance(account.clone());
        require!(
            balance.available.0 >= amount.0,
            "Insufficient available Copper"
        );
        balance.available.0 -= amount.0;
        balance.reserved.0 += amount.0;
        self.balances.insert(&account, &balance);
        let op = Operation {
            amount,
            status: Status::Pending,
            receipt: None,
        };
        self.operations.insert(&key, &op);
        PromiseOrValue::Promise(self.dispatch_withdrawal(&key.1, &key.2, amount))
    }

    pub fn claim_reward(
        &mut self,
        receipt: RewardReceipt,
        signature: Base64VecU8,
    ) -> PromiseOrValue<Operation> {
        require!(
            receipt.account_id == env::predecessor_account_id(),
            "Only reward beneficiary"
        );
        let key = (
            OperationKind::Reward,
            receipt.account_id.clone(),
            receipt.claim_id.clone(),
        );
        if let Some(op) = self.operations.get(&key) {
            require!(
                op.receipt.as_ref() == Some(&receipt),
                "Operation payload mismatch"
            );
            return PromiseOrValue::Value(op);
        }
        require!(!self.paused, "Core paused");
        settlement::assert_dispatch_gas();
        receipt.verify(&self.ruleset, &self.receipt_signer, signature);
        self.charge_operation_storage(&receipt.account_id);
        let op = Operation {
            amount: receipt.amount,
            status: Status::Pending,
            receipt: Some(receipt.clone()),
        };
        self.operations.insert(&key, &op);
        PromiseOrValue::Promise(self.dispatch_reward(&receipt))
    }

    fn storage_cost(bytes: u128) -> u128 {
        env::storage_byte_cost().as_yoctonear() * bytes
    }

    fn charge_operation_storage(&mut self, account: &AccountId) {
        self.charge_storage(account, 1_500);
    }

    fn charge_storage(&mut self, account: &AccountId, bytes: u128) {
        let previous = self.storage_credit.get(account).unwrap_or(0);
        let fee = Self::storage_cost(bytes);
        require!(previous >= fee, "Insufficient operation storage credit");
        self.storage_credit.insert(account, &(previous - fee));
    }

    fn credit(&mut self, account: &AccountId, amount: u128) {
        let mut balance = self.get_balance(account.clone());
        balance.available.0 += amount;
        self.total_allocated += amount;
        self.balances.insert(account, &balance);
    }
}

#[near]
impl FungibleTokenReceiver for Core {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.copper_id || msg.len() > 128 || amount.0 == 0 {
            return PromiseOrValue::Value(amount);
        }
        let Ok(deposit) = near_sdk::serde_json::from_str::<Deposit>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        if !ledger::valid_id(&deposit.operation_id)
            || self.get_storage_credit(sender_id.clone()).0 < Self::storage_cost(1_500)
        {
            return PromiseOrValue::Value(amount);
        }
        let key = (
            OperationKind::Deposit,
            sender_id.clone(),
            deposit.operation_id,
        );
        if self.operations.contains_key(&key) {
            return PromiseOrValue::Value(amount);
        }
        self.charge_operation_storage(&sender_id);
        self.credit(&sender_id, amount.0);
        self.operations.insert(
            &key,
            &Operation {
                amount,
                status: Status::Settled,
                receipt: None,
            },
        );
        PromiseOrValue::Value(U128(0))
    }
}

#[cfg(test)]
mod tests;
