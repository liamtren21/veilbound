use crate::factory::{Artifact, ArtifactKind, ArtifactStatus};
use crate::market::{Order, Side};
use crate::{Core, CoreExt};
use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::{assert_one_yocto, env, near, require, AccountId};

fn open_orders() -> LookupMap<AccountId, u64> {
    LookupMap::new(b"shop-open-orders-v1".to_vec())
}

fn shop_tokens() -> LookupMap<AccountId, String> {
    LookupMap::new(b"shop-order-token-v1".to_vec())
}

impl Core {
    fn shop_for_holder(&self, token_id: &str, expected_epoch: U64) -> Artifact {
        let artifact = self.get_artifact(token_id.into()).expect("Unknown artifact");
        require!(artifact.kind == ArtifactKind::ShopCharter && artifact.status == ArtifactStatus::Ready &&
            !artifact.transfer_pending && artifact.epoch == expected_epoch, "Shop unavailable");
        require!(self.nft.nft_token(token_id.into()).expect("Unknown NFT").owner_id ==
            env::predecessor_account_id(), "Only current holder");
        artifact
    }

    pub(crate) fn assert_market_actor(&self, owner: &AccountId, actor: &AccountId) {
        if let Some(token_id) = shop_tokens().get(owner) {
            let holder = self.nft.nft_token(token_id).expect("Missing Shop Charter").owner_id;
            require!(&holder != actor, "Self fill");
        }
    }

    pub(crate) fn close_shop_order_count(&mut self, owner: &AccountId) {
        let Some(count) = open_orders().get(owner) else { return };
        if count == 1 {
            open_orders().remove(owner);
        } else {
            open_orders().insert(owner, &(count - 1));
        }
    }

    pub(crate) fn assert_shop_orders_closed(&self, artifact: &Artifact) {
        require!(!open_orders().contains_key(&artifact.vault_id), "Shop has open market orders");
    }
}

#[near]
impl Core {
    pub fn get_shop_open_order_count(&self, token_id: String) -> U64 {
        let artifact = self.get_artifact(token_id).expect("Unknown artifact");
        U64(open_orders().get(&artifact.vault_id).unwrap_or(0))
    }

    #[payable]
    pub fn place_shop_order(&mut self, token_id: String, expected_epoch: U64, order_id: String,
        side: Side, item_id: String, quantity: U128, price: U128, expires_at_ns: U64) -> Order {
        assert_one_yocto();
        let artifact = self.shop_for_holder(&token_id, expected_epoch);
        require!(!self.nft_sales.contains_key(&token_id), "Shop listed for sale");
        require!(self.mt_supply(item_id.clone()).is_some(), "Unknown market item");
        let vault_id = artifact.vault_id;
        let holder = env::predecessor_account_id();
        let existing = self.get_market_order(vault_id.clone(), order_id.clone()).is_some();
        let order = self.place_order_for(vault_id.clone(), &holder, order_id, side, item_id, quantity, price, expires_at_ns);
        if !existing {
            if !shop_tokens().contains_key(&vault_id) {
                self.charge_storage(&holder, 350);
                shop_tokens().insert(&vault_id, &token_id);
            }
            let count = open_orders().get(&vault_id).unwrap_or(0);
            open_orders().insert(&vault_id, &count.checked_add(1).expect("Shop order count overflow"));
        }
        order
    }

    #[payable]
    pub fn cancel_shop_order(&mut self, token_id: String, expected_epoch: U64, order_id: String) -> Order {
        assert_one_yocto();
        let artifact = self.shop_for_holder(&token_id, expected_epoch);
        self.cancel_order_for(artifact.vault_id, order_id)
    }
}
