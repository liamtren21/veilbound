const accountPattern = /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet|[a-f0-9]{64})$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,95}$/;
const amountPattern = /^(?:0|[1-9]\d{0,38})$/;
const positive = value => typeof value === 'string' && amountPattern.test(value) &&
  BigInt(value) > 0n && BigInt(value) < (1n << 128n);
const checkAccount = account => {
  if (typeof account !== 'string' || account.length > 64 || !accountPattern.test(account)) throw new Error('invalid_account');
};

export function createCoreClient({ coreId, copperId, transport = fetch }) {
  checkAccount(coreId);
  checkAccount(copperId);
  async function view(contractId, methodName, args, blockHash) {
    const response = await transport('https://test.rpc.fastnear.com', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'core-view', method: 'query', params: {
        request_type: 'call_function', account_id: contractId, method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), ...(blockHash ? { block_id: blockHash } : { finality: 'final' }),
      } }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('chain_unavailable');
    const { result, error } = await response.json();
    if (error || result?.error || !Array.isArray(result?.result)) throw new Error('chain_query_failed');
    return { value: JSON.parse(Buffer.from(result.result).toString()), blockHash: result.block_hash, blockHeight: result.block_height };
  }
  function transaction(methodName, args, gas = '100000000000000') {
    return { network: 'testnet', receiverId: coreId, actions: [{
      type: 'FunctionCall', params: { methodName, args, gas, deposit: '1' },
    }] };
  }
  async function finalizedCall(accountId, transactionHash, method) {
    if (typeof transactionHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(transactionHash)) {
      throw new Error('invalid_transaction_hash');
    }
    const response = await transport('https://test.rpc.fastnear.com', { method: 'POST',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 'final-contract-call', method: 'tx',
        params: { tx_hash: transactionHash, sender_account_id: accountId, wait_until: 'FINAL' } }),
    });
    const { result, error } = await response.json();
    const tx = result?.transaction;
    const call = tx?.actions?.[0]?.FunctionCall;
    if (!response.ok || error || result?.final_execution_status !== 'FINAL' ||
        !Object.hasOwn(result.status ?? {}, 'SuccessValue') || tx?.hash !== transactionHash ||
        tx.signer_id !== accountId || tx.receiver_id !== coreId || tx.actions?.length !== 1 ||
        call?.method_name !== method || result.receipts_outcome?.some(receipt => receipt.outcome?.status?.Failure)) {
      throw new Error('transaction_unverified');
    }
    const args = JSON.parse(Buffer.from(call.args, 'base64').toString());
    return { args, blockHash: result.transaction_outcome?.block_hash ?? null };
  }
  return {
    async rewardStorage(accountId) {
      checkAccount(accountId);
      const { value, blockHash } = await view(coreId, 'get_storage_credit', { account_id: accountId });
      if (!amountPattern.test(value) || !blockHash) throw new Error('chain_query_failed');
      const minimum = 15_000_000_000_000_000_000_000n;
      const credit = BigInt(value);
      // The contract returns zero both before registration and after all credit is spent.
      const registration = credit === 0n ? 1_600_000_000_000_000_000_000n : 0n;
      const deposit = credit < minimum ? String(minimum - credit + registration) : null;
      const funding = deposit === null ? null : transaction('fund_storage', { account_id: accountId }, '30000000000000');
      if (funding) funding.actions[0].params.deposit = deposit;
      return { credit: value, minimum: String(minimum), blockHash, deposit, transaction: funding };
    },
    async runPurse(accountId, runId) {
      checkAccount(accountId);
      if (typeof runId !== 'string' || !idPattern.test(runId)) throw new Error('invalid_run');
      return (await view(coreId, 'get_run_purse', { account_id: accountId, run_id: runId })).value;
    },
    async materialBudget(tokenId) {
      const args = { token_id: tokenId };
      const budget = await view(coreId, 'get_material_reward_budget', args);
      if (budget.value === null) return null;
      const supply = await view(coreId, 'mt_supply', args, budget.blockHash);
      return supply.value === null ? null : budget.value;
    },
    async materialClaim(entitlementId) {
      return (await view(coreId, 'get_material_reward', { entitlement_id: entitlementId })).value;
    },
    async runItemReservation(receipt) {
      checkAccount(receipt.account_id);
      return (await view(coreId, 'get_run_item_reservation', {
        account_id: receipt.account_id, reservation_id: receipt.reservation_id,
      })).value;
    },
    async balances(accountId) {
      checkAccount(accountId);
      const [allocation, wallet] = await Promise.all([
        view(coreId, 'get_balance', { account_id: accountId }),
        view(copperId, 'ft_balance_of', { account_id: accountId }),
      ]);
      return { allocation, wallet };
    },
    order(owner, orderId) {
      checkAccount(owner);
      if (typeof orderId !== 'string' || !idPattern.test(orderId)) throw new Error('invalid_order');
      return view(coreId, 'get_market_order', { owner, order_id: orderId });
    },
    prepareMarketOrder({ orderId, side, tokenId, quantity, price, expiresAtMs }) {
      if (typeof orderId !== 'string' || !idPattern.test(orderId) ||
          typeof tokenId !== 'string' || !idPattern.test(tokenId) || !['buy', 'sell'].includes(side) ||
          !positive(quantity) || !positive(price) || BigInt(quantity) * BigInt(price) >= (1n << 128n) ||
          !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now() ||
          BigInt(expiresAtMs) * 1000000n >= (1n << 64n)) throw new Error('invalid_market_order');
      return transaction('place_market_order', { order_id: orderId, side: side === 'buy' ? 'Buy' : 'Sell', token_id: tokenId,
        quantity, price, expires_at_ns: String(BigInt(expiresAtMs) * 1000000n) });
    },
    async prepareMarketCancel(accountId, { orderId }) {
      const { value } = await this.order(accountId, orderId);
      if (!value || value.cancelled || BigInt(value.remaining) === 0n) throw new Error('order_unavailable');
      return transaction('cancel_market_order', { order_id: orderId });
    },
    async prepareFill(accountId, { owner, orderId, quantity, expectedVersion }) {
      checkAccount(accountId);
      checkAccount(owner);
      if (owner === accountId) throw new Error('self_fill');
      if (typeof quantity !== 'string' || typeof expectedVersion !== 'string' ||
          !amountPattern.test(quantity) || BigInt(quantity) <= 0n || !amountPattern.test(expectedVersion)) throw new Error('invalid_fill');
      const { value: order } = await this.order(owner, orderId);
      if (!order || order.cancelled || order.version !== expectedVersion || BigInt(order.remaining) < BigInt(quantity)) throw new Error('order_unavailable');
      if (BigInt(order.expires_at_ns) <= BigInt(Date.now()) * 1000000n) throw new Error('order_expired');
      return transaction('fill_market_order', { owner, order_id: orderId, quantity, expected_version: expectedVersion });
    },
    async prepareProcurement(accountId, { owner, orderId, quantity, expectedVersion }) {
      checkAccount(accountId);
      if (accountId === owner || !positive(quantity) || typeof expectedVersion !== 'string') throw new Error('procurement_unavailable');
      const snapshot = await this.order(owner, orderId);
      const order = snapshot.value;
      if (order?.side !== 'Buy' || order.cancelled || order.version !== expectedVersion ||
          BigInt(order.remaining) < BigInt(quantity) || BigInt(order.expires_at_ns) <= BigInt(Date.now()) * 1000000n) {
        throw new Error('procurement_unavailable');
      }
      const { value: stock } = await view(coreId, 'get_item_balance', {
        account_id: accountId, token_id: order.token_id,
      }, snapshot.blockHash);
      if (!stock || BigInt(stock.available) < BigInt(quantity)) throw new Error('procurement_stock_unavailable');
      const gross = BigInt(order.price) * BigInt(quantity);
      const fee = (gross * 3n + 99n) / 100n;
      if (fee >= gross) throw new Error('procurement_below_minimum');
      return { transaction: transaction('fill_market_order', { owner, order_id: orderId, quantity, expected_version: expectedVersion }),
        itemId: order.token_id, grossAtomic: String(gross),
        feeAtomic: String(fee), payoutAtomic: String(gross - fee), blockHash: snapshot.blockHash };
    },
    prepareCraft({ operationId, recipeId }) {
      if (typeof operationId !== 'string' || typeof recipeId !== 'string' ||
          !idPattern.test(operationId) || !idPattern.test(recipeId)) throw new Error('invalid_craft');
      return transaction('craft_item', { operation_id: operationId, recipe_id: recipeId });
    },
    async prepareCraftOrder(accountId, { orderId, recipeId, worker, wageAtomic, deadlineMs }) {
      checkAccount(accountId);
      checkAccount(worker);
      if (worker === accountId || typeof orderId !== 'string' || !idPattern.test(orderId) ||
          typeof recipeId !== 'string' || !idPattern.test(recipeId) || !positive(wageAtomic) ||
          !Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now() ||
          BigInt(deadlineMs) * 1000000n >= (1n << 64n)) throw new Error('invalid_craft_order');
      const { value: recipe } = await view(coreId, 'get_recipe', { recipe_id: recipeId });
      if (!recipe || BigInt(recipe.copper_cost) + BigInt(wageAtomic) >= (1n << 128n)) throw new Error('invalid_craft_order');
      return transaction('place_craft_order', { order_id: orderId, recipe_id: recipeId, worker,
        wage: wageAtomic, deadline: String(BigInt(deadlineMs) * 1000000n) });
    },
    async prepareCraftOrderAction(accountId, { buyer, orderId, action }) {
      checkAccount(accountId);
      checkAccount(buyer);
      if (typeof orderId !== 'string' || !idPattern.test(orderId) || !['fulfill', 'cancel'].includes(action)) {
        throw new Error('invalid_craft_order');
      }
      const { value: order } = await view(coreId, 'get_craft_order', { buyer, order_id: orderId });
      if (!order || order.status !== 'open') throw new Error('craft_order_unavailable');
      if (action === 'cancel') {
        if (buyer !== accountId) throw new Error('craft_order_unauthorized');
        return transaction('cancel_craft_order', { order_id: orderId });
      }
      if (order.worker !== accountId || BigInt(order.deadline) <= BigInt(Date.now()) * 1000000n) {
        throw new Error('craft_order_unavailable');
      }
      return transaction('fulfill_craft_order', { buyer, order_id: orderId });
    },
    async listingInventory(accountId, cursor = '0') {
      checkAccount(accountId);
      if (!amountPattern.test(cursor) || BigInt(cursor) >= (1n << 128n)) throw new Error('invalid_offset');
      const limit = 12;
      const page = await view(coreId, 'nft_tokens_for_owner', { account_id: accountId, from_index: cursor, limit });
      const items = await Promise.all(page.value.filter(token => token.owner_id === accountId).map(async token => {
        const args = { token_id: token.token_id };
        const [artifact, sale, rental, lock] = await Promise.all([
          'get_artifact', 'get_nft_sale', 'get_nft_rental', 'get_nft_run_lock',
        ].map(method => view(coreId, method, args, page.blockHash)));
        if (artifact.value?.status !== 'ready' || artifact.value.transfer_pending) return null;
        return { token, sale: sale.value, locked: Boolean(rental.value || lock.value) };
      }));
      return { items: items.filter(Boolean), nextCursor: page.value.length === limit ? String(BigInt(cursor) + BigInt(limit)) : null };
    },
    async expeditionInventory(accountId, offset = '0') {
      checkAccount(accountId);
      if (!amountPattern.test(offset) || BigInt(offset) >= (1n << 128n)) throw new Error('invalid_offset');
      const limit = 24;
      const page = await view(coreId, 'nft_tokens_for_owner', { account_id: accountId, from_index: offset, limit });
      const items = await Promise.all(page.value.filter(token => token.owner_id === accountId).map(async token => {
        const args = { token_id: token.token_id };
        const [artifact, sale] = await Promise.all([
          view(coreId, 'get_artifact', args, page.blockHash),
          view(coreId, 'get_nft_sale', args, page.blockHash),
        ]);
        const kind = artifact.value?.kind;
        if (!['RELIC', 'COMPANION_BOND'].includes(kind) || artifact.value.transfer_pending || sale.value) return null;
        const use = kind === 'RELIC' ? 'get_relic_usage_holder' : 'get_companion_bond';
        const { value } = await view(coreId, use, args, page.blockHash);
        if (kind === 'RELIC' ? value !== accountId : !value) return null;
        return { id: token.token_id, title: token.metadata?.title || token.token_id, kind,
          ready: artifact.value.status === 'ready', companion: kind === 'COMPANION_BOND' ? value : undefined };
      }));
      return { items: items.filter(Boolean), next: page.value.length === limit ? String(BigInt(offset) + BigInt(limit)) : null };
    },
    async artifact(tokenId, blockHash) {
      if (typeof tokenId !== 'string' || !idPattern.test(tokenId)) throw new Error('invalid_artifact');
      const args = { token_id: tokenId };
      const token = await view(coreId, 'nft_token', args, blockHash);
      const [artifact, sale, policy, stage] = await Promise.all([
        view(coreId, 'get_artifact', args, token.blockHash),
        view(coreId, 'get_nft_sale', args, token.blockHash), view(coreId, 'get_artifact_policy', args, token.blockHash),
        view(coreId, 'get_artifact_stage', args, token.blockHash),
      ]);
      return { token, artifact, sale, policy, stage };
    },
    chronicleEntry(tokenId, entryId, blockHash) {
      return view(coreId, 'get_chronicle_entry', { token_id: tokenId, entry_id: entryId }, blockHash);
    },
    evolutionRecipe(stage, blockHash) {
      return view(coreId, 'get_evolution_recipe', { stage }, blockHash);
    },
    async evolutionResources(accountId, tokenId, itemIds, blockHash) {
      checkAccount(accountId);
      const args = { account_id: accountId };
      const token = { token_id: tokenId };
      const [allocation, storage, rental, lock, ...items] = await Promise.all([
        view(coreId, 'get_balance', args, blockHash),
        view(coreId, 'get_storage_credit', args, blockHash),
        view(coreId, 'get_nft_rental', token, blockHash),
        view(coreId, 'get_nft_run_lock', token, blockHash),
        ...itemIds.map(token_id => view(coreId, 'get_item_balance', { ...args, token_id }, blockHash)),
      ]);
      if ([allocation, storage, rental, lock, ...items].some(result => result.blockHash !== blockHash)) {
        throw new Error('chain_query_failed');
      }
      return { copperAtomic: allocation.value.available, storageYocto: storage.value,
        locked: Boolean(rental.value || lock.value), items: items.map(result => result.value.available) };
    },
    prepareEvolution({ tokenId, stage, entryId, recipe }) {
      return transaction('evolve_artifact_media', {
        token_id: tokenId, stage, required_entry_id: entryId, media: recipe.media, media_hash: recipe.media_hash,
      });
    },
    async nftSales({ cursor = '0', limit = 12 } = {}) {
      if (typeof cursor !== 'string' || !amountPattern.test(cursor) ||
          BigInt(cursor) >= 1n << 128n || !Number.isInteger(limit) || limit < 1 || limit > 20) {
        throw new Error('invalid_market_page');
      }
      const page = await view(coreId, 'nft_tokens', { from_index: cursor, limit });
      const entries = await Promise.all(page.value.map(async token => {
        const sale = await view(coreId, 'get_nft_sale', { token_id: token.token_id }, page.blockHash);
        return sale.value ? { token, sale: sale.value } : null;
      }));
      return { listings: entries.filter(Boolean), blockHash: page.blockHash,
        nextCursor: page.value.length === limit ? String(BigInt(cursor) + BigInt(limit)) : null };
    },
    async nftSaleSnapshot(tokenId, itemIds = []) {
      if (!Array.isArray(itemIds) || itemIds.length > 16 ||
          itemIds.some(id => typeof id !== 'string' || !idPattern.test(id))) throw new Error('invalid_snapshot_items');
      const snapshot = await this.artifact(tokenId);
      const vaultId = snapshot.artifact.value?.vault_id;
      if (!vaultId || snapshot.artifact.value.kind === 'COMPANION_BOND') return snapshot;
      const block = snapshot.token.blockHash;
      const [copper, ...balances] = await Promise.all([
        view(coreId, 'get_balance', { account_id: vaultId }, block),
        ...[...new Set(itemIds)].map(token_id => view(coreId, 'get_item_balance', { account_id: vaultId, token_id }, block)),
      ]);
      return { ...snapshot, vault: { copper: copper.value, items: [...new Set(itemIds)].map((id, index) =>
        ({ id, balance: balances[index].value })) } };
    },
    async nftSaleCredit(accountId) {
      checkAccount(accountId);
      const args = { account_id: accountId };
      const available = await view(coreId, 'get_sale_credit', args);
      const pending = await view(coreId, 'get_pending_sale_withdrawal', args, available.blockHash);
      return { available: available.value, pending: pending.value, blockHash: available.blockHash };
    },
    async prepareNftSaleWithdrawal(accountId) {
      const credit = await this.nftSaleCredit(accountId);
      if (!positive(credit.available) || credit.pending !== null) throw new Error('sale_credit_unavailable');
      return transaction('withdraw_sale_credit', {});
    },
    async confirmMarketFill(accountId, { transactionHash, owner, orderId, quantity, expectedVersion }) {
      checkAccount(accountId);
      checkAccount(owner);
      if (owner === accountId || typeof orderId !== 'string' || !idPattern.test(orderId) ||
          !positive(quantity) || typeof expectedVersion !== 'string' || !amountPattern.test(expectedVersion)) {
        throw new Error('invalid_market_fill_confirmation');
      }
      const { args } = await finalizedCall(accountId, transactionHash, 'fill_market_order');
      if (args.owner !== owner || args.order_id !== orderId || args.quantity !== quantity ||
          args.expected_version !== expectedVersion) throw new Error('transaction_unverified');
      return { status: 'FINAL', transactionHash, owner, orderId, quantity };
    },
    async confirmNftSale(accountId, { transactionHash, tokenId, action }) {
      checkAccount(accountId);
      const method = { list: 'list_nft', buy: 'buy_nft', cancel: 'cancel_nft_sale' }[action];
      if (!['list', 'buy', 'cancel'].includes(action) || typeof tokenId !== 'string' || !idPattern.test(tokenId) ||
          typeof transactionHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(transactionHash)) {
        throw new Error('invalid_nft_sale_confirmation');
      }
      const { args, blockHash } = await finalizedCall(accountId, transactionHash, method)
        .catch(() => { throw new Error('nft_sale_unverified'); });
      if (args.token_id !== tokenId) throw new Error('nft_sale_unverified');
      return { action, tokenId, transactionHash, signerId: accountId, status: 'FINAL',
        blockHash };
    },
    async prepareNftRental(accountId, { tokenId, action, priceYocto, durationHours, expectedEpoch }) {
      checkAccount(accountId);
      if (typeof tokenId !== 'string' || !idPattern.test(tokenId)) throw new Error('invalid_artifact');
      const args = { token_id: tokenId };
      const snapshot = await this.artifact(tokenId);
      const rental = (await view(coreId, 'get_nft_rental', args, snapshot.token.blockHash)).value;
      if (action === 'accept' && rental && !rental.renter && rental.owner !== accountId &&
          rental.epoch === expectedEpoch && rental.price === priceYocto && positive(priceYocto)) {
        const prepared = transaction('accept_nft_rental', { ...args, expected_epoch: expectedEpoch });
        prepared.actions[0].params.deposit = priceYocto;
        return prepared;
      }
      if (action === 'cancel' && rental?.owner === accountId && !rental.renter && rental.epoch === expectedEpoch) {
        return transaction('cancel_nft_rental', { ...args, expected_epoch: expectedEpoch });
      }
      if (action === 'list' && snapshot.token.value?.owner_id === accountId &&
          snapshot.artifact.value?.kind === 'RELIC' && !rental && !snapshot.sale.value &&
          positive(priceYocto) && BigInt(priceYocto) >= 100n && [24, 168].includes(durationHours)) {
        return transaction('list_nft_rental', { ...args, price: priceYocto, duration_hours: durationHours });
      }
      throw new Error('rental_unavailable');
    },
    guildTreasury(guildId) {
      if (typeof guildId !== 'string' || !idPattern.test(guildId)) throw new Error('invalid_guild');
      return view(coreId, 'get_guild_treasury', { guild_id: guildId });
    },
    guildPayment(guildId, paymentId) {
      if (![guildId, paymentId].every(id => typeof id === 'string' && idPattern.test(id))) throw new Error('invalid_guild_payment');
      return view(coreId, 'get_guild_payment', { guild_id: guildId, payment_id: paymentId });
    },
    companionBond(tokenId) {
      if (typeof tokenId !== 'string' || !idPattern.test(tokenId)) throw new Error('invalid_artifact');
      return view(coreId, 'get_companion_bond', { token_id: tokenId });
    },
    nftRental(tokenId) {
      if (typeof tokenId !== 'string' || !idPattern.test(tokenId)) throw new Error('invalid_artifact');
      return view(coreId, 'get_nft_rental', { token_id: tokenId });
    },
    async prepareNftRunLock(accountId, tokenId, runId) {
      const binding = await this.bindRunNfts(accountId, { relicToken: tokenId }).catch(async error => {
        if (error.message !== 'relic_unavailable') throw error;
        return this.bindRunNfts(accountId, { companionToken: tokenId });
      });
      return transaction('reserve_nft_run', { token_id: tokenId, run_id: runId,
        expected_epoch: binding.relicEpoch ?? binding.companionEpoch });
    },
    async bindRunNfts(accountId, { relicToken, companionToken, runId }) {
      checkAccount(accountId);
      const first = await this.artifact(relicToken ?? companionToken);
      const blockHash = first.token.blockHash;
      const binding = { accountId };
      if (relicToken) {
        const holder = await view(coreId, 'get_relic_usage_holder', { token_id: relicToken }, blockHash);
        if (holder.value !== accountId) throw new Error('relic_unavailable');
        binding.relicToken = relicToken;
        binding.relicEpoch = first.artifact.value?.epoch;
      }
      if (companionToken) {
        const snapshot = relicToken ? await this.artifact(companionToken, blockHash) : first;
        const bond = await view(coreId, 'get_companion_bond', { token_id: companionToken }, blockHash);
        if (snapshot.token.value?.owner_id !== accountId || snapshot.artifact.value?.kind !== 'COMPANION_BOND' ||
            snapshot.artifact.value?.transfer_pending || snapshot.sale.value || !bond.value) throw new Error('companion_unavailable');
        binding.companionToken = companionToken;
        binding.companionId = bond.value;
        binding.companionEpoch = snapshot.artifact.value.epoch;
      }
      if (runId) {
        const locks = await Promise.all([relicToken, companionToken].filter(Boolean).map(token_id =>
          view(coreId, 'get_nft_run_lock', { token_id }, blockHash)));
        if (locks.some(({ value }) => value?.holder !== accountId || value.run_id !== runId)) {
          throw new Error('nft_run_lock_required');
        }
        binding.expiresAtNs = locks.map(({ value }) => value.expires_at_ns)
          .reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
      }
      return binding;
    },
    prepareGuildAction({ action, guildId, members, operationId, paymentId, recipient, amount, expiresAtMs }) {
      const validId = value => typeof value === 'string' && idPattern.test(value);
      if (!validId(guildId)) throw new Error('invalid_guild');
      const args = { guild_id: guildId };
      if (action === 'create') {
        if (!Array.isArray(members) || members.length < 2 || members.length > 16 ||
            new Set(members).size !== members.length) throw new Error('invalid_guild_members');
        members.forEach(checkAccount);
        return transaction('create_guild_treasury', { ...args, members });
      }
      if (action === 'contribute' && validId(operationId) && positive(amount)) {
        return transaction('contribute_guild_copper', { ...args, operation_id: operationId, amount });
      }
      if (action === 'propose' && validId(paymentId) && positive(amount) &&
          Number.isSafeInteger(expiresAtMs) && expiresAtMs > Date.now() && expiresAtMs - Date.now() <= 604800000) {
        checkAccount(recipient);
        return transaction('propose_guild_payment', { ...args, payment_id: paymentId, recipient, amount,
          expires_at_ns: String(BigInt(expiresAtMs) * 1000000n) });
      }
      if (action === 'approve' && validId(paymentId)) {
        return transaction('approve_guild_payment', { ...args, payment_id: paymentId });
      }
      if (action === 'release-expired' && validId(paymentId)) {
        const prepared = transaction('release_expired_guild_payment', { ...args, payment_id: paymentId });
        prepared.actions[0].params.deposit = '0';
        return prepared;
      }
      throw new Error('invalid_guild_action');
    },
    async prepareCharterOrder(accountId, input) {
      checkAccount(accountId);
      const { charterId, expectedEpoch, action, orderId } = input;
      const snapshot = await this.artifact(charterId);
      const artifact = snapshot.artifact.value;
      if (snapshot.token.value?.owner_id !== accountId || artifact?.kind !== 'SHOP_CHARTER' ||
          artifact.status !== 'ready' || artifact.transfer_pending || snapshot.sale.value || artifact.epoch !== expectedEpoch) {
        throw new Error('charter_unavailable');
      }
      const binding = { token_id: charterId, expected_epoch: expectedEpoch };
      if (action === 'fund') {
        const { copper = '0', items = [] } = input;
        if ((copper !== '0' && !positive(copper)) || !Array.isArray(items) || items.length > 16 ||
            (copper === '0' && items.length === 0) ||
            items.some(item => typeof item?.tokenId !== 'string' || !idPattern.test(item.tokenId) || !positive(item.amount)) ||
            new Set(items.map(item => item.tokenId)).size !== items.length) throw new Error('invalid_shop_funding');
        const [balance, ...stock] = await Promise.all([
          view(coreId, 'get_balance', { account_id: accountId }, snapshot.token.blockHash),
          ...items.map(item => view(coreId, 'get_item_balance', {
            account_id: accountId, token_id: item.tokenId,
          }, snapshot.token.blockHash)),
        ]);
        if (BigInt(balance.value?.available ?? '0') < BigInt(copper) ||
            stock.some(({ value }, index) => BigInt(value?.available ?? '0') < BigInt(items[index].amount))) {
          throw new Error('shop_funding_unavailable');
        }
        return transaction('fund_artifact', { token_id: charterId, copper,
          item_ids: items.map(item => item.tokenId), amounts: items.map(item => item.amount) });
      }
      if (action === 'cancel') {
        const { value } = await this.order(artifact.vault_id, orderId);
        if (!value || value.cancelled || BigInt(value.remaining) === 0n) throw new Error('order_unavailable');
        return transaction('cancel_shop_order', { ...binding, order_id: orderId });
      }
      if (action !== 'place') throw new Error('invalid_shop_order_action');
      const { token_id: itemId, ...args } = this.prepareMarketOrder(input).actions[0].params.args;
      return transaction('place_shop_order', { ...args, ...binding, item_id: itemId });
    },
    async prepareNftSale(accountId, { tokenId, action, priceYocto, expectedEpoch }) {
      checkAccount(accountId);
      if (!['list', 'cancel', 'buy'].includes(action)) throw new Error('invalid_sale_action');
      const snapshot = await this.artifact(tokenId);
      const token = snapshot.token.value;
      const artifact = snapshot.artifact.value;
      const sale = snapshot.sale.value;
      if (!token || !artifact || artifact.status !== 'ready' || artifact.transfer_pending) throw new Error('artifact_unavailable');
      if (action === 'buy') {
        if (!sale || sale.seller === accountId || typeof expectedEpoch !== 'string' ||
            expectedEpoch !== sale.epoch || expectedEpoch !== artifact.epoch || !positive(sale.price)) throw new Error('sale_unavailable');
        const prepared = transaction('buy_nft', { token_id: tokenId, expected_epoch: expectedEpoch });
        prepared.actions[0].params.deposit = sale.price;
        return prepared;
      }
      if (token.owner_id !== accountId) throw new Error('artifact_holder_required');
      if (action === 'cancel') {
        if (sale?.seller !== accountId) throw new Error('sale_unavailable');
        return transaction('cancel_nft_sale', { token_id: tokenId });
      }
      if (!positive(priceYocto) || BigInt(priceYocto) < 100n) throw new Error('invalid_sale_price');
      return transaction('list_nft', { token_id: tokenId, price: priceYocto });
    },
  };
}
