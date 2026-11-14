use crate::{Core, CoreExt};
use crate::factory::ArtifactStatus;
use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_sdk::{near, env, require, assert_one_yocto, AccountId, Promise, NearToken, Gas, PromiseResult};
use near_sdk::json_types::{U128, U64};

#[near(serializers = [borsh, json])]
pub struct Sale {
    pub seller: AccountId,
    pub price: U128,
    pub epoch: U64,
}

#[near]
impl Core {
    pub fn get_nft_sale(&self, token_id: String) -> Option<Sale> { self.nft_sales.get(&token_id) }
    pub fn get_sale_credit(&self, account_id: AccountId) -> U128 {
        U128(self.sale_credits.get(&account_id).unwrap_or(0))
    }

    pub fn get_pending_sale_withdrawal(&self, account_id: AccountId) -> Option<U128> {
        self.sale_pending.get(&account_id).map(U128)
    }

    #[payable]
    pub fn list_nft(&mut self, token_id: String, price: U128) -> Sale {
        assert_one_yocto();
        require!(!self.paused && price.0 >= 100, "Invalid sale");
        self.assert_not_rented(&token_id);
        let seller = env::predecessor_account_id();
        let artifact = self.artifacts.get(&token_id).expect("Unknown artifact");
        self.assert_shop_orders_closed(&artifact);
        require!(artifact.status == ArtifactStatus::Ready && !artifact.transfer_pending, "Artifact locked");
        require!(self.nft.nft_token(token_id.clone()).expect("Unknown NFT").owner_id == seller, "Only holder");
        if let Some(existing) = self.nft_sales.get(&token_id) {
            require!(existing.seller == seller && existing.price == price && existing.epoch == artifact.epoch, "Sale conflict");
            return existing;
        }
        self.charge_storage(&seller, 600);
        let sale = Sale { seller, price, epoch: artifact.epoch };
        self.nft_sales.insert(&token_id, &sale);
        sale
    }

    #[payable]
    pub fn cancel_nft_sale(&mut self, token_id: String) {
        assert_one_yocto();
        let sale = self.nft_sales.get(&token_id).expect("Unknown sale");
        require!(sale.seller == env::predecessor_account_id(), "Only seller");
        self.nft_sales.remove(&token_id);
    }

    #[payable]
    pub fn buy_nft(&mut self, token_id: String, expected_epoch: U64) {
        require!(!self.paused, "Core paused");
        let sale = self.nft_sales.get(&token_id).expect("Unknown sale");
        require!(sale.epoch == expected_epoch && env::attached_deposit().as_yoctonear() == sale.price.0, "Quote changed");
        let buyer = env::predecessor_account_id();
        require!(buyer != sale.seller, "Self purchase");
        let mut artifact = self.artifacts.get(&token_id).expect("Unknown artifact");
        require!(artifact.status == ArtifactStatus::Ready && !artifact.transfer_pending && artifact.epoch == sale.epoch, "Artifact locked");
        require!(self.nft.nft_token(token_id.clone()).expect("Unknown NFT").owner_id == sale.seller, "Owner changed");
        let fee = sale.price.0 / 10000 * 250 + ((sale.price.0 % 10000) * 250 + 9999) / 10000;
        self.nft.internal_transfer(&sale.seller, &buyer, &token_id, None, Some("market sale".into()));
        artifact.epoch.0 += 1;
        self.artifacts.insert(&token_id, &artifact);
        self.nft_sales.remove(&token_id);
        let seller_credit = self.sale_credits.get(&sale.seller).unwrap_or(0);
        self.sale_credits.insert(&sale.seller, &seller_credit.checked_add(sale.price.0 - fee).expect("Credit overflow"));
        let owner_credit = self.sale_credits.get(&self.owner_id).unwrap_or(0);
        self.sale_credits.insert(&self.owner_id, &owner_credit.checked_add(fee).expect("Credit overflow"));
    }

    #[payable]
    pub fn withdraw_sale_credit(&mut self) -> Promise {
        assert_one_yocto();
        require!(env::prepaid_gas() >= Gas::from_tgas(30), "Attach 30 Tgas");
        let account = env::predecessor_account_id();
        require!(!self.sale_pending.contains_key(&account), "Withdrawal pending");
        let amount = self.sale_credits.remove(&account).unwrap_or(0);
        require!(amount > 0, "No sale credit");
        self.sale_pending.insert(&account, &amount);
        Promise::new(account.clone()).transfer(NearToken::from_yoctonear(amount)).then(
            Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).on_sale_withdraw(account))
    }

    #[private]
    pub fn on_sale_withdraw(&mut self, account: AccountId) -> bool {
        let Some(amount) = self.sale_pending.remove(&account) else { return false; };
        let success = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if !success {
            let previous = self.sale_credits.get(&account).unwrap_or(0);
            self.sale_credits.insert(&account, &previous.checked_add(amount).expect("Credit overflow"));
        }
        success
    }
}
