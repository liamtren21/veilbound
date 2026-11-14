import { NearConnector } from '@hot-labs/near-connect';
const connector = new NearConnector({ network: 'testnet', features: { signAndSendTransaction: true } });
const status = document.querySelector('#status');
const connect = document.querySelector('#connect');
const deploy = document.querySelector('#deploy');
let wallet;
let plan;
const rpc = async params => {
  const response = await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(JSON.stringify(result.error ?? result));
  return result.result;
};
async function codeMatches(name) {
  const result = await rpc({ request_type: 'view_code', account_id: plan.contracts[name], finality: 'final' });
  const bytes = Uint8Array.from(atob(result.code_base64), c => c.charCodeAt(0));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(c => c.toString(16).padStart(2, '0')).join('');
  if (hash !== plan.artifacts[name].sha256) throw new Error('Contract code hash differs for ' + name);
}
async function view(account, method, args = {}) {
  const result = await rpc({ request_type: 'call_function', account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)), finality: 'final' });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
}
connect.onclick = async () => {
  try {
    plan = await (await fetch('/plan')).json();
    if (wallet && plan.phase === 'npc-capital') await connector.disconnect(wallet);
    wallet = await connector.connect();
    const accounts = await wallet.getAccounts();
    if (plan.phase === 'npc-capital') {
      const progress = await (await fetch('/progress')).json();
      const next = plan.batches.find((_, index) => !progress.completed.includes(index));
      if (!next) {
        status.textContent = 'NPC funding and operating-key transactions finalized.';
        deploy.disabled = true;
        return;
      }
      if (accounts[0]?.accountId !== next.signerId) throw new Error('Select ' + next.signerId + ' in your wallet, then click Connect wallet again.');
      status.textContent = 'Connected ' + next.signerId + '. You can approve the next transaction.';
      deploy.disabled = false;
      return;
    }
    if (!accounts.some(a => a.accountId === plan.rootAccountId)) throw new Error('Connect ' + plan.rootAccountId);
    const account = await rpc({ request_type: 'view_account', account_id: plan.rootAccountId, finality: 'final' });
    const progress = await (await fetch('/progress')).json();
    const required = plan.batches.filter((_, index) => !progress.completed.includes(index)).flatMap(b => b.actions)
      .reduce((sum, a) => sum + BigInt(a.params?.deposit ?? '0'), 0n);
    status.textContent = 'Connected ' + plan.rootAccountId + '. Balance ' + Number(BigInt(account.amount) / 10n ** 20n) / 10000 + ' testNEAR.';
    if (BigInt(account.amount) <= required + 100000000000000000000000n) {
      throw new Error('Add testNEAR. Remaining attached deposits require ' + String(Number(required / 10n ** 18n) / 1000000) + ' testNEAR plus fees.');
    }
    deploy.disabled = false;
  } catch (error) { status.textContent = error.message; deploy.disabled = true; }
};
deploy.onclick = async () => {
  deploy.disabled = true;
  try {
    for (let index = 0; index < plan.batches.length; index++) {
      const batch = plan.batches[index];
      const progress = await (await fetch('/progress')).json();
      if (progress.completed.includes(index)) continue;
      if (plan.phase === 'evolution') {
        await codeMatches('core');
        const values = await Promise.all(batch.actions.map(({ params }) =>
          view(plan.contracts.core, 'get_evolution_recipe', { stage: params.args.stage })));
        if (values.every((value, index) => matchesEvolution(value, batch.actions[index].params.args.recipe))) continue;
        if (values.some(value => value !== null)) throw new Error('Evolution recipes changed. Regenerate the plan.');
      }
      if (plan.phase === 'material-catalog') {
        await codeMatches('core');
        if (await view(plan.contracts.core, 'is_paused') !== false) throw new Error('Core is paused');
        const token_ids = batch.actions.map(({ params }) => params.args.token_id);
        const supplies = await view(plan.contracts.core, 'mt_batch_supply', { token_ids });
        if (supplies.every(supply => supply !== null)) continue;
        if (supplies.some(supply => supply !== null)) throw new Error('Material catalog changed. Refresh the deployment plan.');
      }
      if (plan.phase === 'material-budgets') {
        await codeMatches('core');
        if (await view(plan.contracts.core, 'is_paused') !== false) throw new Error('Core is paused');
        const { receiverId, actions } = batch;
        const budgets = await Promise.all(actions.map(({ params }) =>
          view(receiverId, 'get_material_reward_budget', { token_id: params.args.token_id })));
        if (budgets.every((budget, i) => budget?.[0] === actions[i].params.args.maximum)) continue;
        if (budgets.some(budget => budget !== null)) throw new Error('Material budgets changed. Refresh the deployment plan.');
      }
      if (!plan.phase && index < 2) {
        let account;
        try { account = await rpc({ request_type: 'view_account', account_id: batch.receiverId, finality: 'final' }); }
        catch (error) {
          if (!error.message.includes('UNKNOWN_ACCOUNT')) throw error;
        }
        if (account) {
          await codeMatches(index === 0 ? 'copper' : 'core');
          if (index === 0) await view(batch.receiverId, 'ft_metadata');
          else await view(batch.receiverId, 'is_paused');
          continue;
        }
      }
      if (['upgrade', 'unpause', 'field-operator'].includes(plan.phase)) {
        const check = await fetch('/preflight', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ index }) });
        const detail = await check.json();
        if (!check.ok || !detail.verified) throw new Error(detail.error ?? 'Phase preconditions failed');
      }
      if (plan.phase === 'npc-capital') {
        const [selected] = await wallet.getAccounts();
        if (selected?.accountId !== batch.signerId) {
          status.textContent = 'Next signer: ' + batch.signerId + '. Select this account in your wallet and click Connect wallet again.';
          return;
        }
      }
      if (['npc-accounts', 'npc-capital', 'fastauth-relay'].includes(plan.phase)) {
        const response = await fetch('/preflight', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ index }) });
        if (!response.ok) throw new Error((await response.json()).error);
      }
      status.textContent = 'Approve transaction ' + (index + 1) + '/' + plan.batches.length + ' in your wallet.';
      const actions = batch.actions.map(action => action.type === 'DeployContract' ? {
        ...action, params: { code: Uint8Array.from(atob(action.params.code), c => c.charCodeAt(0)) },
      } : action);
      const outcome = await wallet.signAndSendTransaction({ network: 'testnet', signerId: batch.signerId ?? plan.rootAccountId,
        receiverId: batch.receiverId, actions });
      const hash = outcome.transaction?.hash;
      if (!hash) throw new Error('Wallet returned no transaction hash. Check the transaction before retrying.');
      const response = await fetch('/record', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index, hash }) });
      if (!response.ok) throw new Error('Final receipt not verified. Transaction ' + hash);
      if (!plan.phase && index < 2) await codeMatches(index === 0 ? 'copper' : 'core');
    }
    if (plan.phase === 'upgrade') {
      const response = await fetch('/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const report = await response.json();
      if (!response.ok || report.status !== 'VERIFIED_PAUSED') throw new Error(report.error ?? 'Upgrade verification failed');
      status.textContent = 'Upgrade finalized and verified. Core is paused. The separate unpause phase is ready for review.';
      return;
    }
    if (plan.phase === 'unpause') {
      if (await view(plan.contracts.core, 'is_paused') !== false) throw new Error('Core unpause is not verified');
      await codeMatches('copper');
      await codeMatches('core');
      status.textContent = 'Core unpause finalized and contract code verified.';
      return;
    }
    if (plan.phase === 'evolution') {
      for (const [stage, expected] of Object.entries(plan.recipes)) {
        const actual = await view(plan.contracts.core, 'get_evolution_recipe', { stage: Number(stage) });
        if (!matchesEvolution(actual, expected)) throw new Error('Evolution stage was not verified: ' + stage);
      }
      status.textContent = 'Relic evolution recipes finalized and verified.';
      return;
    }
    if (plan.phase === 'material-budgets') {
      for (const [token_id, { maximum }] of Object.entries(plan.budgets)) {
        const budget = await view(plan.contracts.core, 'get_material_reward_budget', { token_id });
        if (budget?.[0] !== maximum) throw new Error('Material budget was not verified for ' + token_id);
      }
      status.textContent = 'All material reward budgets finalized and verified.';
      return;
    }
    if (plan.phase === 'material-catalog') {
      const supplies = await view(plan.contracts.core, 'mt_batch_supply', { token_ids: plan.materialIds });
      if (supplies.length !== plan.materialIds.length || supplies.some(supply => supply === null)) {
        throw new Error('Material catalog registration is incomplete.');
      }
      status.textContent = 'Material catalog registration finalized and verified.';
      return;
    }
    if (plan.phase === 'field-operator') {
      status.textContent = 'Field operator setup transactions finalized. Continue with operator deposit and scoped-key verification.';
      return;
    }
    if (plan.phase === 'npc-capital') {
      status.textContent = 'NPC funding and operating-key transactions finalized.';
      return;
    }
    if (plan.phase === 'fastauth-relay') {
      status.textContent = 'FastAuth relayer account creation finalized.';
      return;
    }
    if (plan.phase === 'npc-accounts') {
      status.textContent = 'All four NPC accounts were created and their transactions finalized.';
      return;
    }
    status.textContent = plan.phase === 'onboarding' ? 'Onboarding permission finalized. Continue with scoped-key verification.' :
      plan.phase === 'setup' ? 'Setup transactions finalized. Verify Copper custody, recipes, vaults and Starter Pool.' :
      'Deploy transactions finalized. Core remains paused. Continue with configuration and verification.';
  } catch (error) { status.textContent = error.message; }
};


function matchesEvolution(actual, expected) {
  return actual && Object.keys(expected).every(key => JSON.stringify(actual[key]) === JSON.stringify(expected[key]));
}
