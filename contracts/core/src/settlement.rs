use crate::ledger::{valid_id, Operation, OperationKind, Status};
use crate::receipts::RewardReceipt;
use crate::{Core, CoreExt};
use near_sdk::json_types::{U128, U64};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue,
};

const COPPER_GAS: Gas = Gas::from_tgas(20);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);

#[near(serializers = [json])]
pub struct WithdrawalResult {
    pub receiver_id: AccountId,
    pub amount: U128,
    pub sent: bool,
}

#[near(serializers = [json])]
pub struct MintResult {
    pub receiver_id: AccountId,
    pub amount: U128,
    pub epoch: Option<U64>,
}

#[allow(dead_code)]
#[ext_contract(copper)]
trait Copper {
    fn withdraw_custody(
        &mut self,
        operation_id: String,
        receiver_id: AccountId,
        amount: U128,
    ) -> WithdrawalResult;
    fn mint_reward(
        &mut self,
        claim_id: String,
        amount: U128,
        epoch: U64,
        expires_at_ns: U64,
    ) -> Option<MintResult>;
}

pub fn assert_dispatch_gas() {
    require!(
        env::prepaid_gas() >= Gas::from_tgas(60),
        "Attach at least 60 Tgas"
    );
}

#[near]
impl Core {
    pub fn retry_settlement(
        &mut self,
        operation_id: String,
        kind: OperationKind,
    ) -> PromiseOrValue<Operation> {
        require!(valid_id(&operation_id), "Invalid operation ID");
        let account_id = env::predecessor_account_id();
        let op = self
            .get_operation(operation_id.clone(), account_id.clone(), kind)
            .expect("Unknown operation");
        if op.status != Status::Pending {
            return PromiseOrValue::Value(op);
        }
        assert_dispatch_gas();
        let promise = match kind {
            OperationKind::Withdraw => {
                self.dispatch_withdrawal(&account_id, &operation_id, op.amount)
            }
            OperationKind::Reward => {
                self.dispatch_reward(op.receipt.as_ref().expect("Missing receipt"))
            }
            OperationKind::Deposit => env::panic_str("Unexpected pending deposit"),
        };
        PromiseOrValue::Promise(promise)
    }

    #[private]
    pub fn on_withdrawal(
        &mut self,
        account_id: AccountId,
        operation_id: String,
        #[callback_result] result: Result<WithdrawalResult, PromiseError>,
    ) -> Operation {
        let key = (OperationKind::Withdraw, account_id.clone(), operation_id);
        let mut op = self.operations.get(&key).expect("Unknown withdrawal");
        let Ok(result) = result else { return op };
        if op.status == Status::Pending {
            require!(
                result.receiver_id == account_id && result.amount == op.amount,
                "Withdrawal result mismatch"
            );
            let mut balance = self.get_balance(account_id.clone());
            balance.reserved.0 -= op.amount.0;
            if result.sent {
                self.total_allocated -= op.amount.0;
                op.status = Status::Settled;
            } else {
                balance.available.0 += op.amount.0;
                op.status = Status::Refunded;
            }
            self.balances.insert(&account_id, &balance);
            self.operations.insert(&key, &op);
        }
        op
    }

    #[private]
    pub fn on_reward(
        &mut self,
        account_id: AccountId,
        operation_id: String,
        #[callback_result] result: Result<Option<MintResult>, PromiseError>,
    ) -> Operation {
        let key = (OperationKind::Reward, account_id.clone(), operation_id);
        let mut op = self.operations.get(&key).expect("Unknown reward");
        let Ok(result) = result else { return op };
        if op.status == Status::Pending {
            let receipt = op.receipt.as_ref().expect("Missing receipt");
            if let Some(result) = result {
                require!(
                    result.receiver_id == env::current_account_id()
                        && result.amount == op.amount
                        && result.epoch == Some(receipt.epoch),
                    "Reward result mismatch"
                );
                self.credit(&account_id, op.amount.0);
                op.status = Status::Settled;
            } else {
                op.status = Status::Expired;
            }
            self.operations.insert(&key, &op);
        }
        op
    }

    pub(crate) fn dispatch_withdrawal(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        amount: U128,
    ) -> Promise {
        copper::ext(self.copper_id.clone())
            .with_static_gas(COPPER_GAS)
            .with_attached_deposit(NearToken::from_yoctonear(Self::storage_cost(600)))
            .withdraw_custody(
                scoped_id("withdraw", account_id, operation_id),
                account_id.clone(),
                amount,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_withdrawal(account_id.clone(), operation_id.into()),
            )
    }

    pub(crate) fn dispatch_reward(&self, receipt: &RewardReceipt) -> Promise {
        copper::ext(self.copper_id.clone())
            .with_static_gas(COPPER_GAS)
            .with_attached_deposit(NearToken::from_yoctonear(Self::storage_cost(600)))
            .mint_reward(
                scoped_id("reward", &receipt.account_id, &receipt.claim_id),
                receipt.amount,
                receipt.epoch,
                receipt.expires_at_ns,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_reward(receipt.account_id.clone(), receipt.claim_id.clone()),
            )
    }
}

fn scoped_id(domain: &str, account_id: &AccountId, operation_id: &str) -> String {
    env::sha256_array(format!("{domain}\n{account_id}\n{operation_id}").as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
