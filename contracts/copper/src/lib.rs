use near_contract_standards::fungible_token::{
    core::FungibleTokenCore,
    events::{FtBurn, FtMint},
    metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC},
    resolver::FungibleTokenResolver,
    FungibleToken,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise, PromiseOrValue};

mod emissions;
use emissions::{Claim, Emissions};

#[near(serializers = [borsh, json])]
pub struct Withdrawal {
    pub receiver_id: AccountId,
    pub amount: U128,
    pub sent: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Copper {
    token: FungibleToken,
    owner_id: AccountId,
    core_id: AccountId,
    emissions: Emissions,
    burns: LookupMap<String, u128>,
    withdrawals: LookupMap<String, Withdrawal>,
}

#[near]
impl Copper {
    pub fn get_reward_budget(&self) -> emissions::RewardBudget {
        self.emissions.budget(self.current_epoch().0)
    }
    #[init]
    pub fn new(
        owner_id: AccountId,
        core_id: AccountId,
        bootstrap_cap: U128,
        global_reward_cap: U128,
        epoch_length_ns: U64,
        epoch_reward_cap: U128,
    ) -> Self {
        require!(epoch_length_ns.0 > 0, "Epoch length must be positive");
        require!(
            bootstrap_cap.0.checked_add(global_reward_cap.0).is_some(),
            "Emission caps overflow"
        );
        let mut token = FungibleToken::new(b"balances".to_vec());
        token.internal_register_account(&core_id);
        Self {
            token,
            owner_id,
            core_id,
            emissions: Emissions::new(
                bootstrap_cap.0,
                global_reward_cap.0,
                epoch_length_ns.0,
                epoch_reward_cap.0,
            ),
            burns: LookupMap::new(b"burns".to_vec()),
            withdrawals: LookupMap::new(b"withdrawals".to_vec()),
        }
    }

    pub fn current_epoch(&self) -> U64 {
        U64(env::block_timestamp() / self.emissions.epoch_length_ns)
    }

    pub fn upgrade(&mut self, wasm: near_sdk::json_types::Base64VecU8) -> near_sdk::Promise {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        require!(wasm.0.len() >= 8 && wasm.0[..8] == [0, 97, 115, 109, 1, 0, 0, 0], "Invalid WASM");
        near_sdk::Promise::new(env::current_account_id()).deploy_contract(wasm.0)
    }

    pub fn get_mint_claim(&self, claim_id: String) -> Option<Claim> {
        self.emissions.claims.get(&claim_id)
    }

    pub fn get_burn(&self, operation_id: String) -> Option<U128> {
        self.burns.get(&operation_id).map(U128)
    }

    pub fn bootstrap(&mut self, claim_id: String, receiver_id: AccountId, amount: U128) -> Claim {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        let claim = Claim {
            receiver_id,
            amount,
            epoch: None,
        };
        if self
            .emissions
            .apply(&claim_id, &claim, self.current_epoch().0)
        {
            self.mint(&claim, "bootstrap");
        }
        claim
    }

    #[payable]
    pub fn mint_reward(
        &mut self,
        claim_id: String,
        amount: U128,
        epoch: U64,
        expires_at_ns: Option<U64>,
    ) -> Option<Claim> {
        require!(env::predecessor_account_id() == self.core_id, "Only Core");
        let initial_storage = env::storage_usage();
        let claim = Claim {
            receiver_id: self.core_id.clone(),
            amount,
            epoch: Some(epoch),
        };
        emissions::validate_id(&claim_id);
        if let Some(previous) = self.emissions.claims.get(&claim_id) {
            require!(previous == claim, "Claim payload mismatch");
            self.refund_unused_storage(initial_storage);
            return Some(previous);
        }
        if expires_at_ns.is_some_and(|deadline| env::block_timestamp() > deadline.0)
            || epoch.0 != self.current_epoch().0
        {
            self.refund_unused_storage(initial_storage);
            return None;
        }
        if self
            .emissions
            .apply(&claim_id, &claim, self.current_epoch().0)
        {
            self.mint(&claim, "reward");
        }
        self.refund_unused_storage(initial_storage);
        Some(claim)
    }

    pub fn burn_custody(&mut self, operation_id: String, amount: U128) -> U128 {
        require!(env::predecessor_account_id() == self.core_id, "Only Core");
        emissions::validate_id(&operation_id);
        require!(amount.0 > 0, "Amount must be positive");
        if let Some(previous) = self.burns.get(&operation_id) {
            require!(previous == amount.0, "Burn payload mismatch");
            return amount;
        }
        self.token.internal_withdraw(&self.core_id, amount.0);
        self.burns.insert(&operation_id, &amount.0);
        FtBurn {
            owner_id: &self.core_id,
            amount,
            memo: Some("custody sink"),
        }
        .emit();
        amount
    }

    #[payable]
    pub fn withdraw_custody(
        &mut self,
        operation_id: String,
        receiver_id: AccountId,
        amount: U128,
    ) -> Withdrawal {
        require!(env::predecessor_account_id() == self.core_id, "Only Core");
        let initial_storage = env::storage_usage();
        emissions::validate_id(&operation_id);
        require!(
            amount.0 > 0 && receiver_id != self.core_id,
            "Invalid withdrawal"
        );
        if let Some(previous) = self.withdrawals.get(&operation_id) {
            require!(
                previous.amount == amount && previous.receiver_id == receiver_id,
                "Withdrawal payload mismatch"
            );
            self.refund_unused_storage(initial_storage);
            return previous;
        }
        let sent = self.token.accounts.get(&receiver_id).is_some()
            && self.ft_balance_of(self.core_id.clone()).0 >= amount.0;
        if sent {
            self.token.internal_transfer(
                &self.core_id,
                &receiver_id,
                amount.0,
                Some("custody withdrawal".into()),
            );
        }
        let withdrawal = Withdrawal {
            receiver_id,
            amount,
            sent,
        };
        self.withdrawals.insert(&operation_id, &withdrawal);
        self.refund_unused_storage(initial_storage);
        withdrawal
    }

    fn refund_unused_storage(&self, initial_storage: u64) {
        let bytes = env::storage_usage().saturating_sub(initial_storage);
        let required = u128::from(bytes) * env::storage_byte_cost().as_yoctonear();
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= required, "Insufficient receipt storage deposit");
        if attached > required {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(attached - required));
        }
    }

    fn mint(&mut self, claim: &Claim, memo: &str) {
        self.token
            .internal_deposit(&claim.receiver_id, claim.amount.0);
        FtMint {
            owner_id: &claim.receiver_id,
            amount: claim.amount,
            memo: Some(memo),
        }
        .emit();
    }
}

#[near]
impl FungibleTokenCore for Copper {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Copper {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.token
            .ft_resolve_transfer(sender_id, receiver_id, amount)
    }
}

#[near]
impl StorageManagement for Copper {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        require!(
            env::predecessor_account_id() != self.core_id,
            "Core custody must remain registered"
        );
        self.token.storage_unregister(force)
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Copper {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.into(),
            name: "Veilbound Copper".into(),
            symbol: "COPPER".into(),
            decimals: 2,
            icon: None,
            reference: None,
            reference_hash: None,
        }
    }
}

#[cfg(test)]
mod tests;
