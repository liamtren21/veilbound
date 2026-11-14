use crate::{Core, CoreExt};
use near_contract_standards::non_fungible_token::{events::NftMint, metadata::TokenMetadata};
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ArtifactKind {
    Relic,
    ShopCharter,
    CompanionBond,
}

#[near(serializers = [borsh, json])]
#[derive(PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactStatus {
    Creating,
    Ready,
    FailedRefundable,
    Refunding,
    FailedRefunded,
}

#[near(serializers = [borsh, json])]
pub struct Artifact {
    pub kind: ArtifactKind,
    pub vault_id: AccountId,
    pub status: ArtifactStatus,
    pub epoch: U64,
    pub transfer_pending: bool,
    initial_owner: AccountId,
    creator: AccountId,
    funding: U128,
    metadata: Option<TokenMetadata>,
}

#[near(serializers = [json])]
pub struct VaultIdentity {
    core_id: AccountId,
    token_id: String,
    kind: ArtifactKind,
}

#[near]
impl Core {
    pub fn get_companion_bond(&self, token_id: String) -> Option<String> {
        near_sdk::collections::LookupMap::new(b"companion-bond-v1".to_vec()).get(&token_id)
    }

    #[payable]
    pub fn mint_companion_bond(&mut self, token_id: String, owner_id: AccountId, companion_id: String, metadata: TokenMetadata) {
        near_sdk::assert_one_yocto();
        let issuer = env::predecessor_account_id();
        require!(!self.paused && issuer == self.owner_id && owner_id != env::current_account_id(), "Only active issuer");
        require!(valid_token_id(&token_id) && !self.artifacts.contains_key(&token_id), "Invalid or duplicate token");
        require!(["brinewisp", "flintback", "chimewing", "waxwing", "cindermoth", "scriptfin"]
            .contains(&companion_id.as_str()), "Unknown companion");
        metadata.assert_valid();
        require!(serde_json::to_vec(&metadata).expect("Invalid metadata").len() <= 1024, "Metadata too large");
        self.charge_storage(&issuer, 4000);
        self.nft.internal_mint_with_refund(token_id.clone(), owner_id.clone(), Some(metadata), None);
        self.artifacts.insert(&token_id, &Artifact {
            kind: ArtifactKind::CompanionBond, vault_id: env::current_account_id(), status: ArtifactStatus::Ready,
            epoch: U64(0), transfer_pending: false, initial_owner: owner_id.clone(), creator: issuer,
            funding: U128(0), metadata: None,
        });
        let mut bonds: near_sdk::collections::LookupMap<String, String> =
            near_sdk::collections::LookupMap::new(b"companion-bond-v1".to_vec());
        bonds.insert(&token_id, &companion_id);
        NftMint { owner_id: &owner_id, token_ids: &[&token_id], memo: None }.emit();
    }

    pub fn pin_vault_template(&mut self, code_hash: Base64VecU8) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        require!(
            self.vault_code_hash.is_none(),
            "Vault template already pinned"
        );
        self.vault_code_hash = Some(
            code_hash
                .0
                .try_into()
                .expect("Expected 32-byte WASM SHA-256"),
        );
    }

    pub fn get_artifact(&self, token_id: String) -> Option<Artifact> {
        self.artifacts.get(&token_id)
    }

    #[payable]
    pub fn create_artifact(
        &mut self,
        token_id: String,
        owner_id: AccountId,
        kind: ArtifactKind,
        metadata: TokenMetadata,
        vault_wasm: Base64VecU8,
    ) -> Promise {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        require!(!self.paused, "Core paused");
        require!(kind != ArtifactKind::CompanionBond, "Use companion mint");
        require!(
            env::prepaid_gas() >= Gas::from_tgas(100),
            "Attach at least 100 Tgas"
        );
        require!(valid_token_id(&token_id), "Invalid token ID");
        require!(
            !self.artifacts.contains_key(&token_id),
            "Artifact already exists"
        );
        metadata.assert_valid();
        require!(
            serde_json::to_vec(&metadata)
                .expect("Invalid metadata")
                .len()
                <= 1024,
            "Metadata too large"
        );
        require!(vault_wasm.0.len() <= 300_000, "Vault WASM too large");
        require!(
            Some(env::sha256_array(&vault_wasm.0)) == self.vault_code_hash,
            "Vault WASM hash mismatch"
        );
        let vault_id: AccountId = format!("v-{}.{}", token_id, env::current_account_id())
            .parse()
            .expect("Invalid vault account");
        let funding = Self::storage_cost(vault_wasm.0.len() as u128 + 4_000);
        let registry_cost = Self::storage_cost(5_000);
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= funding + registry_cost,
            "Insufficient vault and registry funding"
        );
        let creator = env::predecessor_account_id();
        let artifact = Artifact {
            kind,
            vault_id: vault_id.clone(),
            status: ArtifactStatus::Creating,
            epoch: U64(0),
            transfer_pending: false,
            initial_owner: owner_id,
            creator: creator.clone(),
            funding: U128(funding),
            metadata: Some(metadata),
        };
        self.artifacts.insert(&token_id, &artifact);
        let surplus = attached - funding - registry_cost;
        if surplus > 0 {
            Promise::new(creator).transfer(NearToken::from_yoctonear(surplus));
        }
        let identity = VaultIdentity {
            core_id: env::current_account_id(),
            token_id: token_id.clone(),
            kind,
        };
        Promise::new(vault_id)
            .create_account()
            .transfer(NearToken::from_yoctonear(funding))
            .deploy_contract(vault_wasm.0)
            .function_call(
                "new".into(),
                serde_json::to_vec(&identity).expect("Vault init encoding"),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(15),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(35))
                    .on_vault_created(token_id),
            )
    }

    pub fn reconcile_artifact(&self, token_id: String) -> Promise {
        let artifact = self.artifacts.get(&token_id).expect("Unknown artifact");
        require!(
            artifact.status == ArtifactStatus::Creating,
            "Artifact is not creating"
        );
        Promise::new(artifact.vault_id)
            .function_call(
                "confirm_identity".into(),
                b"{}".to_vec(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(10),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(30))
                    .on_vault_identity(token_id),
            )
    }

    #[private]
    pub fn on_vault_created(&mut self, token_id: String) -> Artifact {
        let mut artifact = self.artifacts.get(&token_id).expect("Unknown artifact");
        if artifact.status == ArtifactStatus::Creating {
            match env::promise_result(0) {
                near_sdk::PromiseResult::Successful(_) => {
                    self.finish_vault(&token_id, &mut artifact)
                }
                near_sdk::PromiseResult::Failed => {
                    artifact.status = ArtifactStatus::FailedRefundable;
                    self.artifacts.insert(&token_id, &artifact);
                }
            }
        }
        artifact
    }

    #[private]
    pub fn on_vault_identity(
        &mut self,
        token_id: String,
        #[callback_result] result: Result<VaultIdentity, PromiseError>,
    ) -> Artifact {
        let mut artifact = self.artifacts.get(&token_id).expect("Unknown artifact");
        if artifact.status == ArtifactStatus::Creating {
            if let Ok(identity) = result {
                require!(
                    identity.core_id == env::current_account_id()
                        && identity.token_id == token_id
                        && identity.kind == artifact.kind,
                    "Vault identity mismatch"
                );
                self.finish_vault(&token_id, &mut artifact);
            }
        }
        artifact
    }

    pub fn refund_failed_artifact(&mut self, token_id: String) -> Promise {
        let mut artifact = self.artifacts.get(&token_id).expect("Unknown artifact");
        require!(
            env::predecessor_account_id() == artifact.creator,
            "Only artifact creator"
        );
        require!(
            artifact.status == ArtifactStatus::FailedRefundable,
            "Artifact is not refundable"
        );
        artifact.status = ArtifactStatus::Refunding;
        self.artifacts.insert(&token_id, &artifact);
        Promise::new(artifact.creator)
            .transfer(NearToken::from_yoctonear(artifact.funding.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .on_artifact_refund(token_id),
            )
    }

    #[private]
    pub fn on_artifact_refund(&mut self, token_id: String) -> Artifact {
        let mut artifact = self.artifacts.get(&token_id).expect("Unknown artifact");
        if artifact.status == ArtifactStatus::Refunding {
            artifact.status = match env::promise_result(0) {
                near_sdk::PromiseResult::Successful(_) => ArtifactStatus::FailedRefunded,
                near_sdk::PromiseResult::Failed => ArtifactStatus::FailedRefundable,
            };
            self.artifacts.insert(&token_id, &artifact);
        }
        artifact
    }

    fn finish_vault(&mut self, token_id: &str, artifact: &mut Artifact) {
        let metadata = artifact.metadata.take().expect("Missing NFT metadata");
        self.nft.internal_mint_with_refund(
            token_id.into(),
            artifact.initial_owner.clone(),
            Some(metadata),
            None,
        );
        NftMint {
            owner_id: &artifact.initial_owner,
            token_ids: &[token_id],
            memo: None,
        }
        .emit();
        artifact.status = ArtifactStatus::Ready;
        self.artifacts.insert(&token_id.into(), artifact);
    }
}

fn valid_token_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && !id.starts_with('-')
        && !id.ends_with('-')
        && !id.contains("--")
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
