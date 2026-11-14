use crate::{Core, CoreExt};
use crate::factory::{ArtifactKind, ArtifactStatus};
use crate::ledger::valid_id;
use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::{assert_one_yocto, env, near, require, AccountId};

#[near(serializers = [borsh])]
pub(crate) struct StarterPool {
    configuration: Option<StarterConfiguration>,
    issued: u64,
    grants: LookupMap<String, StarterGrant>,
    relics: LookupMap<String, String>,
    accounts: LookupMap<AccountId, String>,
}

impl StarterPool {
    pub(crate) fn new() -> Self {
        Self {
            configuration: None,
            issued: 0,
            grants: LookupMap::new(b"starter-grant".to_vec()),
            relics: LookupMap::new(b"starter-relic".to_vec()),
            accounts: LookupMap::new(b"starter-account".to_vec()),
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct StarterConfiguration {
    pub copper: U128,
    pub token_ids: Vec<String>,
    pub quantities: Vec<U128>,
    pub grant_cap: U64,
}

#[near(serializers = [borsh, json])]
pub struct StarterGrant {
    pub relic_id: String,
    pub linked_account: Option<AccountId>,
    pub claimed: bool,
}

#[near(serializers = [borsh, json])]
#[derive(PartialEq)]
pub struct StarterSpend {
    pub copper: U128,
    pub quantities: Vec<U128>,
}

#[near(serializers = [json])]
pub struct StarterInventory {
    pub copper: U128,
    pub token_ids: Vec<String>,
    pub quantities: Vec<U128>,
}

fn remaining_inventory() -> LookupMap<String, StarterSpend> {
    LookupMap::new(b"starter-inventory-v1".to_vec())
}

fn run_spending() -> LookupMap<(String, String), StarterSpend> {
    LookupMap::new(b"starter-run-spend-v1".to_vec())
}

#[near(serializers = [json])]
pub struct StarterPoolStatus {
    pub issued: U64,
    pub configuration: Option<StarterConfiguration>,
    pub available_copper: U128,
}

#[near]
impl Core {
    pub fn increase_starter_capacity(&mut self, new_cap: U64) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        let configuration = self.starter.configuration.as_mut().expect("Starter pool is unavailable");
        require!(new_cap.0 > configuration.grant_cap.0, "Starter capacity must increase");
        configuration.grant_cap = new_cap;
    }

    pub fn get_starter_pool(&self) -> StarterPoolStatus {
        StarterPoolStatus {
            issued: U64(self.starter.issued),
            configuration: self.starter.configuration.clone(),
            available_copper: self.get_balance(self.owner_id.clone()).available,
        }
    }

    pub fn configure_starter(&mut self, configuration: StarterConfiguration) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        require!(self.starter.configuration.is_none(), "Starter configuration is already set");
        require!(configuration.copper.0 > 0 && configuration.grant_cap.0 > 0 &&
            configuration.token_ids.len() <= 2, "Invalid starter budget");
        self.check_item_batch(&self.owner_id, &configuration.token_ids, &configuration.quantities);
        self.starter.configuration = Some(configuration);
    }

    pub fn get_starter_configuration(&self) -> Option<StarterConfiguration> {
        self.starter.configuration.clone()
    }

    pub fn get_starter_grant(&self, grant_id: String) -> Option<StarterGrant> {
        self.starter.grants.get(&grant_id)
    }

    pub fn get_starter_inventory(&self, grant_id: String) -> Option<StarterInventory> {
        let grant = self.starter.grants.get(&grant_id)?;
        if grant.claimed { return None; }
        let configuration = self.starter.configuration.clone()?;
        let remaining = remaining_inventory().get(&grant_id).unwrap_or(StarterSpend {
            copper: configuration.copper,
            quantities: configuration.quantities,
        });
        Some(StarterInventory {
            copper: remaining.copper,
            token_ids: configuration.token_ids,
            quantities: remaining.quantities,
        })
    }

    pub fn get_starter_run_spend(&self, grant_id: String, run_id: String) -> Option<StarterSpend> {
        run_spending().get(&(grant_id, run_id))
    }

    pub fn settle_starter_run(
        &mut self, grant_id: String, run_id: String, copper: U128, quantities: Vec<U128>,
    ) -> StarterSpend {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        require!(valid_id(&run_id), "Invalid run ID");
        let key = (grant_id.clone(), run_id);
        let spend = StarterSpend { copper, quantities };
        let mut spending = run_spending();
        if let Some(previous) = spending.get(&key) {
            require!(previous == spend, "Starter spend payload mismatch");
            return previous;
        }
        require!(!self.paused, "Core paused");
        let grant = self.starter.grants.get(&grant_id).expect("Unknown starter grant");
        require!(!grant.claimed && grant.linked_account.is_none(), "Starter grant cannot be spent");
        let inventory = self.get_starter_inventory(grant_id.clone()).expect("Missing starter inventory");
        require!(spend.copper.0 <= inventory.copper.0 &&
            spend.quantities.len() == inventory.quantities.len() &&
            spend.quantities.iter().zip(&inventory.quantities).all(|(used, left)| used.0 <= left.0),
            "Starter spend exceeds remaining inventory");
        require!(spend.copper.0 > 0 || spend.quantities.iter().any(|used| used.0 > 0), "Empty starter spend");

        let operator = self.owner_id.clone();
        self.charge_storage(&operator, 500);
        let mut balance = self.get_balance(operator.clone());
        balance.reserved.0 -= spend.copper.0;
        balance.available.0 += spend.copper.0;
        self.balances.insert(&operator, &balance);
        self.burn_starter_items(&operator, &inventory.token_ids, &spend.quantities);
        remaining_inventory().insert(&grant_id, &StarterSpend {
            copper: U128(inventory.copper.0 - spend.copper.0),
            quantities: inventory.quantities.iter().zip(&spend.quantities)
                .map(|(left, used)| U128(left.0 - used.0)).collect(),
        });
        spending.insert(&key, &spend);
        spend
    }

    pub fn issue_starter(&mut self, grant_id: String, relic_id: String) -> StarterGrant {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        require!(valid_id(&grant_id), "Invalid starter grant ID");
        if let Some(previous) = self.starter.grants.get(&grant_id) {
            require!(previous.relic_id == relic_id, "Starter grant payload mismatch");
            return previous;
        }
        require!(!self.paused, "Core paused");
        let configuration = self.starter.configuration.clone().expect("Starter pool is unavailable");
        require!(self.starter.issued < configuration.grant_cap.0, "Starter pool grant cap reached");
        require!(!self.starter.relics.contains_key(&relic_id), "Relic already assigned");
        let artifact = self.artifacts.get(&relic_id).expect("Unknown starter relic");
        require!(artifact.status == ArtifactStatus::Ready && artifact.kind == ArtifactKind::Relic &&
            !artifact.transfer_pending, "Relic is unavailable");
        require!(self.nft.nft_token(relic_id.clone()).expect("Missing relic").owner_id ==
            env::current_account_id(), "Relic is outside starter custody");

        let operator = self.owner_id.clone();
        let mut balance = self.get_balance(operator.clone());
        require!(balance.available.0 >= configuration.copper.0, "Starter Copper pool is depleted");
        self.check_item_batch(&operator, &configuration.token_ids, &configuration.quantities);
        self.charge_storage(&operator, 1_500);
        balance.available.0 -= configuration.copper.0;
        balance.reserved.0 += configuration.copper.0;
        self.balances.insert(&operator, &balance);
        self.lock_starter_items(&operator, &configuration.token_ids, &configuration.quantities);
        let grant = StarterGrant { relic_id: relic_id.clone(), linked_account: None, claimed: false };
        self.starter.grants.insert(&grant_id, &grant);
        self.starter.relics.insert(&relic_id, &grant_id);
        self.starter.issued += 1;
        grant
    }

    pub fn link_starter(&mut self, grant_id: String, account_id: AccountId) -> StarterGrant {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        require!(account_id != env::current_account_id() && account_id != self.owner_id, "Invalid linked account");
        let mut grant = self.starter.grants.get(&grant_id).expect("Unknown starter grant");
        if let Some(previous) = &grant.linked_account {
            require!(*previous == account_id, "Grant is already linked");
            return grant;
        }
        require!(!self.starter.accounts.contains_key(&account_id), "Account already has a starter grant");
        grant.linked_account = Some(account_id.clone());
        self.starter.accounts.insert(&account_id, &grant_id);
        self.starter.grants.insert(&grant_id, &grant);
        grant
    }

    #[payable]
    pub fn claim_starter(&mut self, grant_id: String) -> StarterGrant {
        assert_one_yocto();
        let beneficiary = env::predecessor_account_id();
        let mut grant = self.starter.grants.get(&grant_id).expect("Unknown starter grant");
        require!(grant.linked_account.as_ref() == Some(&beneficiary), "Only linked account");
        if grant.claimed {
            return grant;
        }
        require!(!self.paused, "Core paused");
        let inventory = self.get_starter_inventory(grant_id.clone()).expect("Missing starter inventory");
        let mut artifact = self.artifacts.get(&grant.relic_id).expect("Unknown starter relic");
        require!(!artifact.transfer_pending, "Relic transfer is locked");
        let operator = self.owner_id.clone();
        let mut source = self.get_balance(operator.clone());
        let mut target = self.get_balance(beneficiary.clone());
        if inventory.copper.0 > 0 {
            source.reserved.0 -= inventory.copper.0;
            target.available.0 += inventory.copper.0;
            self.balances.insert(&operator, &source);
            self.balances.insert(&beneficiary, &target);
        }
        let (ids, amounts): (Vec<_>, Vec<_>) = inventory.token_ids.into_iter().zip(inventory.quantities)
            .filter(|(_, amount)| amount.0 > 0).unzip();
        if !ids.is_empty() {
            self.claim_starter_items(&operator, &beneficiary, &ids, &amounts);
        }
        self.nft.internal_transfer(&env::current_account_id(), &beneficiary, &grant.relic_id, None, Some("starter claim".into()));
        artifact.epoch.0 += 1;
        self.artifacts.insert(&grant.relic_id, &artifact);
        grant.claimed = true;
        self.starter.grants.insert(&grant_id, &grant);
        grant
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    #[test]
    fn starter_settlement_conserves_copper_and_consumes_items_once() {
        testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_near(1)).build());
        let mut core = Core::new(accounts(0), accounts(1), near_sdk::json_types::Base64VecU8(vec![1; 32]), "test".into());
        core.set_paused(false);
        core.fund_storage(None);
        core.credit(&accounts(0), 1000);
        core.register_item("salve".into(), "Salve".into(), U64(1), U128(2));
        core.bootstrap_item("starter-test".into(), accounts(0), "salve".into(), U128(2));
        let ids = vec!["salve".to_owned()];
        core.configure_starter(StarterConfiguration {
            copper: U128(1000), token_ids: ids.clone(), quantities: vec![U128(2)], grant_cap: U64(1),
        });
        core.starter.grants.insert(&"g".into(), &StarterGrant { relic_id: "r".into(), linked_account: None, claimed: false });
        let mut balance = core.get_balance(accounts(0));
        balance.available = U128(0);
        balance.reserved = U128(1000);
        core.balances.insert(&accounts(0), &balance);
        core.lock_starter_items(&accounts(0), &ids, &[U128(2)]);

        for _ in 0..2 {
            core.settle_starter_run("g".into(), "run".into(), U128(300), vec![U128(1)]);
        }
        let remaining = core.get_starter_inventory("g".into()).unwrap();
        assert_eq!(remaining.copper, U128(700));
        assert_eq!(remaining.quantities, vec![U128(1)]);
        let balance = core.get_balance(accounts(0));
        assert_eq!(balance.available, U128(300));
        assert_eq!(balance.reserved, U128(700));
        assert_eq!(core.mt_supply("salve".into()), Some(U128(1)));
        assert_eq!(core.get_total_allocated(), U128(1000));
    }
}
