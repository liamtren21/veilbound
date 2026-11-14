use crate::ledger::valid_id;
use crate::{Core, CoreExt};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::{assert_one_yocto, env, near, require, AccountId};

const MAX_MEMBERS: usize = 16;
const MAX_PROPOSAL_NS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;

#[near(serializers = [borsh, json])]
pub struct GuildTreasury {
    members: Vec<AccountId>,
    available: U128,
    reserved: U128,
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    fn act_as(index: usize, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(index))
            .attached_deposit(deposit)
            .build());
    }

    #[test]
    fn contribution_and_majority_payment_conserve_copper() {
        act_as(0, NearToken::from_near(1));
        let mut core = Core::new(
            accounts(0),
            accounts(4),
            near_sdk::json_types::Base64VecU8(vec![1; 32]),
            "test".into(),
        );
        core.set_paused(false);
        core.fund_storage(None);
        core.credit(&accounts(0), 1000);
        act_as(0, NearToken::from_yoctonear(1));
        core.create_guild_treasury("guild".into(), vec![accounts(0), accounts(1), accounts(2)]);
        for _ in 0..2 {
            core.contribute_guild_copper("guild".into(), "deposit".into(), U128(500));
        }
        core.propose_guild_payment(
            "guild".into(),
            "pay".into(),
            accounts(3),
            U128(200),
            U64(100),
        );
        core.approve_guild_payment("guild".into(), "pay".into());
        assert_eq!(core.get_balance(accounts(3)).available, U128(0));
        act_as(1, NearToken::from_yoctonear(1));
        for _ in 0..2 {
            core.approve_guild_payment("guild".into(), "pay".into());
        }
        let guild = core.get_guild_treasury("guild".into()).unwrap();
        assert_eq!(guild.available, U128(300));
        assert_eq!(guild.reserved, U128(0));
        assert_eq!(core.get_balance(accounts(3)).available, U128(200));
        assert_eq!(core.get_total_allocated(), U128(1000));
    }
}

#[near(serializers = [borsh, json])]
pub struct GuildPayment {
    recipient: AccountId,
    amount: U128,
    expires_at_ns: U64,
    approvals: Vec<AccountId>,
    status: PaymentStatus,
}

#[near(serializers = [borsh, json])]
#[derive(PartialEq)]
#[serde(rename_all = "snake_case")]
enum PaymentStatus {
    Pending,
    Paid,
    Expired,
}

fn guilds() -> LookupMap<String, GuildTreasury> {
    LookupMap::new(b"guild-treasury-v1".to_vec())
}

fn payments() -> LookupMap<(String, String), GuildPayment> {
    LookupMap::new(b"guild-payment-v1".to_vec())
}

#[near]
impl Core {
    pub fn get_guild_treasury(&self, guild_id: String) -> Option<GuildTreasury> {
        guilds().get(&guild_id)
    }

    pub fn get_guild_payment(&self, guild_id: String, payment_id: String) -> Option<GuildPayment> {
        payments().get(&(guild_id, payment_id))
    }

    #[payable]
    pub fn create_guild_treasury(&mut self, guild_id: String, members: Vec<AccountId>) {
        assert_one_yocto();
        let mut members = members;
        let actor = env::predecessor_account_id();
        require!(
            !self.paused && valid_id(&guild_id) && (2..=MAX_MEMBERS).contains(&members.len()),
            "Invalid guild"
        );
        members.sort();
        let original_len = members.len();
        members.dedup();
        require!(
            members.len() == original_len
                && members.contains(&actor)
                && !members.contains(&env::current_account_id()),
            "Invalid guild members"
        );
        let mut guilds = guilds();
        require!(!guilds.contains_key(&guild_id), "Guild already exists");
        self.charge_storage(&actor, 320 + (members.len() as u128) * 70);
        guilds.insert(
            &guild_id,
            &GuildTreasury {
                members,
                available: U128(0),
                reserved: U128(0),
            },
        );
    }

    #[payable]
    pub fn contribute_guild_copper(
        &mut self,
        guild_id: String,
        operation_id: String,
        amount: U128,
    ) {
        assert_one_yocto();
        require!(
            !self.paused && amount.0 > 0 && valid_id(&operation_id),
            "Invalid contribution"
        );
        let actor = env::predecessor_account_id();
        let mut guilds = guilds();
        let mut guild = guilds.get(&guild_id).expect("Unknown guild");
        require!(guild.members.contains(&actor), "Only guild members");
        let mut receipts: LookupMap<(String, AccountId, String), U128> =
            LookupMap::new(b"guild-contribution-v1".to_vec());
        let key = (guild_id.clone(), actor.clone(), operation_id);
        if let Some(previous) = receipts.get(&key) {
            require!(previous == amount, "Contribution payload conflict");
            return;
        }
        let mut balance = self.get_balance(actor.clone());
        require!(balance.available.0 >= amount.0, "Insufficient Copper");
        self.charge_storage(&actor, 400);
        balance.available.0 -= amount.0;
        guild.available.0 = guild
            .available
            .0
            .checked_add(amount.0)
            .expect("Guild balance overflow");
        self.balances.insert(&actor, &balance);
        guilds.insert(&guild_id, &guild);
        receipts.insert(&key, &amount);
    }

    #[payable]
    pub fn propose_guild_payment(
        &mut self,
        guild_id: String,
        payment_id: String,
        recipient: AccountId,
        amount: U128,
        expires_at_ns: U64,
    ) {
        assert_one_yocto();
        let actor = env::predecessor_account_id();
        let now = env::block_timestamp();
        require!(
            !self.paused
                && valid_id(&payment_id)
                && amount.0 > 0
                && expires_at_ns.0 > now
                && expires_at_ns.0 - now <= MAX_PROPOSAL_NS
                && recipient != env::current_account_id(),
            "Invalid proposal"
        );
        let mut guilds = guilds();
        let mut guild = guilds.get(&guild_id).expect("Unknown guild");
        require!(guild.members.contains(&actor), "Only guild members");
        let mut payments = payments();
        let key = (guild_id.clone(), payment_id);
        if let Some(previous) = payments.get(&key) {
            require!(
                previous.approvals.first() == Some(&actor)
                    && previous.recipient == recipient
                    && previous.amount == amount
                    && previous.expires_at_ns == expires_at_ns,
                "Proposal payload conflict"
            );
            return;
        }
        require!(
            guild.available.0 >= amount.0,
            "Insufficient treasury Copper"
        );
        self.charge_storage(&actor, 500 + (guild.members.len() as u128) * 70);
        guild.available.0 -= amount.0;
        guild.reserved.0 += amount.0;
        guilds.insert(&guild_id, &guild);
        payments.insert(
            &key,
            &GuildPayment {
                recipient,
                amount,
                expires_at_ns,
                approvals: vec![actor],
                status: PaymentStatus::Pending,
            },
        );
    }

    #[payable]
    pub fn approve_guild_payment(&mut self, guild_id: String, payment_id: String) -> GuildPayment {
        assert_one_yocto();
        let actor = env::predecessor_account_id();
        let mut guilds = guilds();
        let mut guild = guilds.get(&guild_id).expect("Unknown guild");
        require!(guild.members.contains(&actor), "Only guild members");
        let mut payments = payments();
        let key = (guild_id.clone(), payment_id);
        let mut payment = payments.get(&key).expect("Unknown payment");
        if payment.status == PaymentStatus::Paid {
            return payment;
        }
        require!(
            !self.paused
                && payment.status == PaymentStatus::Pending
                && env::block_timestamp() < payment.expires_at_ns.0,
            "Payment unavailable"
        );
        if !payment.approvals.contains(&actor) {
            payment.approvals.push(actor);
        }
        if payment.approvals.len() > guild.members.len() / 2 {
            let mut recipient = self.get_balance(payment.recipient.clone());
            recipient.available.0 = recipient
                .available
                .0
                .checked_add(payment.amount.0)
                .expect("Balance overflow");
            self.balances.insert(&payment.recipient, &recipient);
            guild.reserved.0 -= payment.amount.0;
            guilds.insert(&guild_id, &guild);
            payment.status = PaymentStatus::Paid;
        }
        payments.insert(&key, &payment);
        payment
    }

    pub fn release_expired_guild_payment(
        &mut self,
        guild_id: String,
        payment_id: String,
    ) -> GuildPayment {
        let mut payments = payments();
        let key = (guild_id.clone(), payment_id);
        let mut payment = payments.get(&key).expect("Unknown payment");
        if payment.status == PaymentStatus::Expired {
            return payment;
        }
        require!(
            payment.status == PaymentStatus::Pending
                && env::block_timestamp() >= payment.expires_at_ns.0,
            "Payment has not expired"
        );
        let mut guilds = guilds();
        let mut guild = guilds.get(&guild_id).expect("Unknown guild");
        guild.reserved.0 -= payment.amount.0;
        guild.available.0 += payment.amount.0;
        guilds.insert(&guild_id, &guild);
        payment.status = PaymentStatus::Expired;
        payments.insert(&key, &payment);
        payment
    }
}
