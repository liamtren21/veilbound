import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCoreClient } from '../../server/src/chain/core.mjs';

test('NFT sale confirmation binds final receipt to the signer, contract, action and token', async () => {
  const transactionHash = 'A'.repeat(44);
  const transaction = { hash: transactionHash, signer_id: 'buyer.testnet', receiver_id: 'core.testnet',
    actions: [{ FunctionCall: { method_name: 'buy_nft',
      args: Buffer.from(JSON.stringify({ token_id: 'relic-1', expected_epoch: '1' })).toString('base64') } }] };
  const result = { transaction, final_execution_status: 'FINAL', status: { SuccessValue: '' },
    receipts_outcome: [], transaction_outcome: { block_hash: 'block' } };
  const core = createCoreClient({ coreId: 'core.testnet', copperId: 'copper.testnet',
    transport: async () => Response.json({ result }) });
  const request = { transactionHash, tokenId: 'relic-1', action: 'buy' };
  assert.equal((await core.confirmNftSale('buyer.testnet', request)).status, 'FINAL');
  await assert.rejects(core.confirmNftSale('other.testnet', request), /unverified/);
  await assert.rejects(core.confirmNftSale('buyer.testnet', { ...request, tokenId: 'relic-2' }), /unverified/);
  await assert.rejects(core.confirmNftSale('buyer.testnet', { ...request, action: 'cancel' }), /unverified/);
  result.final_execution_status = 'EXECUTED';
  await assert.rejects(core.confirmNftSale('buyer.testnet', request), /unverified/);
});


test('market fill receipt binds the exact order and quantity, and requires finality', async () => {
  const transactionHash = 'B'.repeat(44);
  const input = { transactionHash, owner: 'npc.testnet', orderId: 'salt-1', quantity: '1', expectedVersion: '2' };
  const args = { owner: input.owner, order_id: input.orderId, quantity: input.quantity, expected_version: input.expectedVersion };
  const transaction = { hash: transactionHash, signer_id: 'player.testnet', receiver_id: 'core.testnet',
    actions: [{ FunctionCall: { method_name: 'fill_market_order', args: Buffer.from(JSON.stringify(args)).toString('base64') } }] };
  const result = { transaction, final_execution_status: 'FINAL', status: { SuccessValue: '' }, receipts_outcome: [] };
  const core = createCoreClient({ coreId: 'core.testnet', copperId: 'copper.testnet', transport: async () => Response.json({ result }) });
  assert.equal((await core.confirmMarketFill('player.testnet', input)).status, 'FINAL');
  await assert.rejects(core.confirmMarketFill('player.testnet', { ...input, quantity: '2' }), /unverified/);
  await assert.rejects(core.confirmMarketFill('other.testnet', input), /unverified/);
  result.receipts_outcome.push({ outcome: { status: { Failure: {} } } });
  await assert.rejects(core.confirmMarketFill('player.testnet', input), /unverified/);
});
