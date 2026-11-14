use crate::factory::{ArtifactKind, ArtifactStatus};
use crate::{Core, CoreExt};
use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::{assert_one_yocto, env, near, require, AccountId};

#[near(serializers = [borsh, json])]
pub struct Rental {
    owner: AccountId,
    renter: Option<AccountId>,
    price: U128,
    duration_hours: u16,
    epoch: U64,
    expires_at_ns: U64,
}

fn rentals() -> LookupMap<String, Rental> {
    LookupMap::new(b"relic-rental-v1".to_vec())
}

#[near(serializers = [borsh, json])]
pub struct NftRunLock {
    holder: AccountId,
    run_id: String,
    expires_at_ns: U64,
}

fn run_locks() -> LookupMap<String, NftRunLock> {
    LookupMap::new(b"nft-run-lock-v1".to_vec())
}

fn locked(rental: &Rental) -> bool {
    rental.renter.is_none() || rental.expires_at_ns.0 > env::block_timestamp()
}

impl Core {
    pub(crate) fn assert_not_rented(&self, token_id: &String) {
        require!(
            self.get_nft_run_lock(token_id.clone()).is_none(),
            "NFT committed to a run"
        );
        require!(
            !rentals()
                .get(token_id)
                .is_some_and(|rental| locked(&rental)),
            "Relic rental lock"
        );
    }
}

#[near]
impl Core {
    pub fn get_nft_run_lock(&self, token_id: String) -> Option<NftRunLock> {
        run_locks()
            .get(&token_id)
            .filter(|lock| lock.expires_at_ns.0 > env::block_timestamp())
    }

    #[payable]
    pub fn reserve_nft_run(
        &mut self,
        token_id: String,
        run_id: String,
        expected_epoch: U64,
    ) -> NftRunLock {
        assert_one_yocto();
        let holder = env::predecessor_account_id();
        require!(
            !self.paused && crate::ledger::valid_id(&run_id),
            "Invalid NFT run"
        );
        let artifact = self.artifacts.get(&token_id).expect("Unknown NFT");
        require!(
            artifact.status == ArtifactStatus::Ready
                && !artifact.transfer_pending
                && artifact.epoch == expected_epoch
                && !self.nft_sales.contains_key(&token_id),
            "NFT unavailable"
        );
        let owner = self
            .nft
            .nft_token(token_id.clone())
            .expect("Missing NFT")
            .owner_id;
        let now = env::block_timestamp();
        let expires = now
            .checked_add(45 * 60 * 1_000_000_000)
            .expect("Expiry overflow");
        match artifact.kind {
            ArtifactKind::Relic => {
                require!(
                    self.get_relic_usage_holder(token_id.clone()).as_ref() == Some(&holder),
                    "Only usage holder"
                );
                if let Some(rental) = self.get_nft_rental(token_id.clone()) {
                    require!(
                        rental.expires_at_ns.0 >= expires,
                        "Rental ends before run lock"
                    );
                }
            }
            ArtifactKind::CompanionBond => require!(owner == holder, "Only companion owner"),
            ArtifactKind::ShopCharter => env::panic_str("Shop Charter cannot enter combat"),
        }
        if let Some(lock) = self.get_nft_run_lock(token_id.clone()) {
            require!(
                lock.holder == holder && lock.run_id == run_id,
                "NFT committed to another run"
            );
            return lock;
        }
        self.charge_storage(&holder, 500);
        let lock = NftRunLock {
            holder,
            run_id,
            expires_at_ns: U64(expires),
        };
        run_locks().insert(&token_id, &lock);
        lock
    }
    pub fn get_nft_rental(&self, token_id: String) -> Option<Rental> {
        rentals().get(&token_id).filter(locked)
    }

    pub fn get_relic_usage_holder(&self, token_id: String) -> Option<AccountId> {
        let artifact = self.artifacts.get(&token_id)?;
        if artifact.kind != ArtifactKind::Relic
            || artifact.status != ArtifactStatus::Ready
            || artifact.transfer_pending
            || self.nft_sales.contains_key(&token_id)
        {
            return None;
        }
        if let Some(rental) = self.get_nft_rental(token_id.clone()) {
            return rental.renter;
        }
        self.nft.nft_token(token_id).map(|token| token.owner_id)
    }

    #[payable]
    pub fn list_nft_rental(
        &mut self,
        token_id: String,
        price: U128,
        duration_hours: u16,
    ) -> Rental {
        assert_one_yocto();
        require!(
            !self.paused && price.0 >= 100 && [24, 168].contains(&duration_hours),
            "Invalid rental"
        );
        self.assert_not_rented(&token_id);
        require!(!self.nft_sales.contains_key(&token_id), "Listed for sale");
        let mut artifact = self.artifacts.get(&token_id).expect("Unknown relic");
        require!(
            artifact.kind == ArtifactKind::Relic
                && artifact.status == ArtifactStatus::Ready
                && !artifact.transfer_pending,
            "Relic unavailable"
        );
        let owner = env::predecessor_account_id();
        require!(
            self.nft
                .nft_token(token_id.clone())
                .expect("Missing NFT")
                .owner_id
                == owner,
            "Only holder"
        );
        self.charge_storage(&owner, 550);
        artifact.epoch.0 = artifact.epoch.0.checked_add(1).expect("Epoch overflow");
        let rental = Rental {
            owner,
            renter: None,
            price,
            duration_hours,
            epoch: artifact.epoch,
            expires_at_ns: U64(0),
        };
        self.artifacts.insert(&token_id, &artifact);
        rentals().insert(&token_id, &rental);
        rental
    }

    #[payable]
    pub fn cancel_nft_rental(&mut self, token_id: String, expected_epoch: U64) {
        assert_one_yocto();
        let mut rentals = rentals();
        let rental = rentals.get(&token_id).expect("Unknown rental");
        require!(
            rental.owner == env::predecessor_account_id()
                && rental.epoch == expected_epoch
                && rental.renter.is_none(),
            "Only open listing can be cancelled"
        );
        rentals.remove(&token_id);
    }

    #[payable]
    pub fn accept_nft_rental(&mut self, token_id: String, expected_epoch: U64) -> Rental {
        let renter = env::predecessor_account_id();
        let mut rentals = rentals();
        let mut rental = rentals.get(&token_id).expect("Unknown rental");
        require!(
            !self.paused
                && rental.renter.is_none()
                && rental.owner != renter
                && rental.epoch == expected_epoch
                && rental.price.0 == env::attached_deposit().as_yoctonear(),
            "Rental quote changed"
        );
        rental.renter = Some(renter);
        rental.expires_at_ns = U64(env::block_timestamp()
            .checked_add(u64::from(rental.duration_hours) * 3_600_000_000_000)
            .expect("Expiry overflow"));
        let fee = rental.price.0 / 40 + u128::from(rental.price.0 % 40 != 0);
        for (account, amount) in [(&rental.owner, rental.price.0 - fee), (&self.owner_id, fee)] {
            let credit = self
                .sale_credits
                .get(account)
                .unwrap_or(0)
                .checked_add(amount)
                .expect("Credit overflow");
            self.sale_credits.insert(account, &credit);
        }
        rentals.insert(&token_id, &rental);
        rental
    }
}
