use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Identity {
    pub core_id: AccountId,
    pub token_id: String,
    pub kind: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    identity: Identity,
}

#[near]
impl Vault {
    #[init]
    pub fn new(core_id: AccountId, token_id: String, kind: String) -> Self {
        require!(env::predecessor_account_id() == core_id, "Only Core");
        let account = env::current_account_id();
        require!(
            account
                .as_str()
                .split_once('.')
                .is_some_and(|(_, parent)| parent == core_id.as_str()),
            "Vault must be a direct child of Core"
        );
        require!(
            !token_id.is_empty() && token_id.len() <= 32,
            "Invalid token ID"
        );
        require!(
            matches!(kind.as_str(), "RELIC" | "SHOP_CHARTER"),
            "Invalid artifact kind"
        );
        Self {
            identity: Identity {
                core_id,
                token_id,
                kind,
            },
        }
    }

    pub fn get_identity(&self) -> Identity {
        self.identity.clone()
    }

    pub fn confirm_identity(&self) -> Identity {
        require!(
            env::predecessor_account_id() == self.identity.core_id,
            "Only Core"
        );
        self.identity.clone()
    }
}
