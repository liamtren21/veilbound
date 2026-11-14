use crate::factory::{Artifact, ArtifactStatus};
use crate::{Core, CoreExt};
use near_contract_standards::non_fungible_token::{
    core::{NonFungibleTokenCore, NonFungibleTokenResolver},
    enumeration::NonFungibleTokenEnumeration,
    metadata::{NFTContractMetadata, NonFungibleTokenMetadataProvider, NFT_METADATA_SPEC},
    Token, TokenId,
};
use near_sdk::json_types::U128;
use near_sdk::{near, require, AccountId, PromiseOrValue};
use std::collections::HashMap;

impl Core {
    fn check_nft_transfer(&self, token_id: &TokenId) -> Artifact {
        require!(!self.paused, "Core paused");
        self.assert_not_rented(token_id);
        require!(!self.nft_sales.contains_key(token_id), "Artifact listed for sale");
        let artifact = self.artifacts.get(token_id).expect("Unknown artifact");
        self.assert_shop_orders_closed(&artifact);
        require!(
            artifact.status == ArtifactStatus::Ready && !artifact.transfer_pending,
            "Artifact transfer is locked"
        );
        artifact
    }
}

#[near]
impl NonFungibleTokenCore for Core {
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        let mut artifact = self.check_nft_transfer(&token_id);
        self.nft
            .nft_transfer(receiver_id, token_id.clone(), approval_id, memo);
        artifact.epoch.0 += 1;
        self.artifacts.insert(&token_id, &artifact);
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        let mut artifact = self.check_nft_transfer(&token_id);
        let result =
            self.nft
                .nft_transfer_call(receiver_id, token_id.clone(), approval_id, memo, msg);
        artifact.epoch.0 += 1;
        artifact.transfer_pending = true;
        self.artifacts.insert(&token_id, &artifact);
        result
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.nft.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Core {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        let mut artifact = self.artifacts.get(&token_id).expect("Unknown artifact");
        require!(artifact.transfer_pending, "No provisional transfer");
        let kept = self.nft.nft_resolve_transfer(
            previous_owner_id,
            receiver_id,
            token_id.clone(),
            approved_account_ids,
        );
        if !kept {
            artifact.epoch.0 += 1;
        }
        artifact.transfer_pending = false;
        self.artifacts.insert(&token_id, &artifact);
        kept
    }
}

#[near]
impl NonFungibleTokenEnumeration for Core {
    fn nft_total_supply(&self) -> U128 {
        self.nft.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.nft
            .nft_tokens(from_index, Some(limit.unwrap_or(50).min(50)))
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.nft.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.nft
            .nft_tokens_for_owner(account_id, from_index, Some(limit.unwrap_or(50).min(50)))
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Core {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.into(),
            name: "Veilbound Artifacts".into(),
            symbol: "VEIL".into(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
}
