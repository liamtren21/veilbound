import { speakToNpc } from './npc/dialogue.mjs';
import { createServer } from 'node:http';
import { attachRealtime } from './realtime/ws.mjs';
import { checkoutMethods, previewTestnetIntentQuote } from './economy/intents-checkout.mjs';

const cookieName = 'veilbound_guest';
const getToken = request => request.headers.cookie?.split(';').map(part => part.trim())
  .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);

function reply(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16384) throw Object.assign(new Error(), { status: 413, code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw Object.assign(new Error(), { status: 400, code: 'INVALID_JSON' });
}

export function createGameServer({ sessions, runs, journeys, modes, field, professions, marketIndex, shop, chronicle, walletAuth, socialAuth, nearSocialAuth, economy, starter, telemetry, serveGame, origin, secureCookies = true }) {
  if (!origin) throw new Error('Expected a configured application origin');
  const cookie = (token, maxAge) => `${cookieName}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  const server = createServer(async (request, response) => {
    telemetry?.observeRequest(request, response);
    try {
      const path = new URL(request.url, origin).pathname;
      const { method } = request;
      if (path === '/health' && method === 'GET') return reply(response, 200, { ok: true });
      if (!path.startsWith('/api/') && await serveGame?.(request, response, path)) return;
      if (method === 'POST' && request.headers.origin !== origin) return reply(response, 403, { error: 'INVALID_ORIGIN' });
      const share = /^\/api\/journeys\/([0-9a-f-]{36})$/.exec(path);
      if (journeys && share && method === 'GET') {
        const journey = journeys.read(share[1]);
        return reply(response, journey ? 200 : 404, journey ?? { error: 'NOT_FOUND' });
      }
      const token = getToken(request);
      const playerId = sessions.read(token);
      const challenge = /^\/api\/journeys\/([0-9a-f-]{36})\/challenge$/.exec(path);
      if (journeys && challenge && method === 'POST') {
        if (!playerId) return reply(response, 401, { error: 'SESSION_REQUIRED' });
        const run = await journeys.challenge(playerId, challenge[1]);
        return reply(response, run ? 200 : 404, run ? { runId: run.runId } : { error: 'NOT_FOUND' });
      }
      if (method === 'POST' && path === '/api/npc/dialogue') {
        const input = await readBody(request);
        if (input.runId !== undefined && (typeof input.runId !== 'string' ||
            !/^[A-Za-z0-9_-]{1,96}$/.test(input.runId))) return reply(response, 400, { error: 'INVALID_RUN_ID' });
        if (input.runId && !playerId) return reply(response, 401, { error: 'SESSION_REQUIRED' });
        const context = input.runId ? await runs.dialogueContext(playerId, input.runId) : null;
        if (context && context.node !== input.node) return reply(response, 409, { error: 'NPC_SCENE_CHANGED' });
        const {status, body} = await speakToNpc(playerId, input, context);
        return reply(response, status, body);
      }
      if (path === '/api/auth/near/config' && method === 'GET') {
        return reply(response, 200, { enabled: Boolean(nearSocialAuth), ...(nearSocialAuth ? { clientId: nearSocialAuth.clientId } : {}) });
      }
      if (nearSocialAuth && method === 'POST' && path === '/api/auth/near/challenge') {
        if (playerId) return reply(response, 200, nearSocialAuth.challenge(playerId));
        const session = sessions.create();
        response.setHeader('Set-Cookie', cookie(session.token, session.maxAge));
        return reply(response, 200, nearSocialAuth.challenge(session.playerId, null));
      }
      if (nearSocialAuth && method === 'POST' && path === '/api/auth/near/complete') {
        const body = await readBody(request);
        let identity;
        try { identity = await nearSocialAuth.complete(body, playerId); }
        catch (error) {
          const conflict = error.message === 'profile_conflict';
          return reply(response, conflict ? 409 : 401, { error: conflict ? 'profile_conflict' : 'NEAR_SOCIAL_AUTH_FAILED' });
        }
        const session = sessions.createForPlayer(identity.playerId);
        sessions.revoke(token);
        response.setHeader('Set-Cookie', cookie(session.token, session.maxAge));
        return reply(response, 200, identity);
      }
      if (nearSocialAuth && path === '/api/auth/near/transaction' && ['GET', 'POST'].includes(method)) {
        if (!playerId) return reply(response, 401, { error: 'SESSION_REQUIRED' });
        if (method === 'GET') return reply(response, 200, { enabled: Boolean(economy && nearSocialAuth.canSign(playerId)) });
        if (!economy || !nearSocialAuth.canSign(playerId)) return reply(response, 409, { error: 'NEAR_SOCIAL_LINK_REQUIRED' });
        const body = await readBody(request);
        try {
          let result;
          if (body.id) {
            result = await nearSocialAuth.submitTransaction(playerId, body);
          } else if (body.runId !== undefined) {
            if (typeof body.runId !== 'string' || !/^[\w-]{1,96}$/.test(body.runId) ||
                !Number.isSafeInteger(body.region) || body.region < 1 || body.region > 5) {
              return reply(response, 400, { error: 'INVALID_BANK_REQUEST' });
            }
            const claim = await runs.prepareBank(playerId, body.runId, body.region);
            result = claim.transaction ? await nearSocialAuth.prepareTransaction(playerId, claim.transaction) : { status: claim.status };
          } else {
            const { transaction } = await economy.rewardStorage(walletAuth.accountForPlayer(playerId));
            if (!transaction) return reply(response, 409, { error: 'NEAR_SOCIAL_STORAGE_UNAVAILABLE' });
            result = await nearSocialAuth.prepareTransaction(playerId, transaction);
          }
          return reply(response, 200, result);
        } catch (error) {
          const code = /^NEAR_SOCIAL_[A-Z_]+$/.test(error.message) ? error.message : 'NEAR_SOCIAL_TRANSACTION_UNAVAILABLE';
          return reply(response, 409, { error: code });
        }
      }
      if (method === 'GET' && path === '/api/auth/social/config') {
        return reply(response, 200, { google: socialAuth?.provider === 'google' });
      }
      if (socialAuth && method === 'POST' && path === '/api/auth/social/begin') {
        const attempt = socialAuth.begin(playerId);
        if (socialAuth.provider === 'google') {
          response.setHeader('Set-Cookie', 'veilbound_google_state=' + attempt.state +
            '; Path=/api/auth/social/complete; HttpOnly; SameSite=Lax; Max-Age=300' + (secureCookies ? '; Secure' : ''));
        }
        return reply(response, 200, attempt);
      }
      if (socialAuth && method === 'POST' && path === '/api/auth/social/complete') {
        const body = await readBody(request);
        if (socialAuth.provider === 'google') {
          const stateCookie = request.headers.cookie?.split(';').map(value => value.trim())
            .find(value => value.startsWith('veilbound_google_state='))?.slice('veilbound_google_state='.length);
          if (!stateCookie || stateCookie !== body.state) return reply(response, 401, { error: 'SOCIAL_ATTEMPT_UNAVAILABLE' });
        }
        let identity;
        try { identity = await socialAuth.complete(body, playerId); }
        catch (error) {
          if (socialAuth.provider === 'google') {
            const reason = error.code ?? error.message;
            const safeReason = /^(?:ERR_[A-Z_]+|social_[a-z_]+|invalid_social_[a-z_]+|profile_conflict)$/.test(reason)
              ? reason : 'upstream_error';
            const claim = ['iss', 'aud', 'sub', 'exp', 'iat', 'nbf', 'nonce'].includes(error.claim) ? error.claim : undefined;
            const detail = ['missing', 'invalid', 'check_failed'].includes(error.reason) ? error.reason : undefined;
            console.warn('Google sign-in failed:', [safeReason, claim, detail].filter(Boolean).join(' '));
          }
          return reply(response, error.message === 'profile_conflict' ? 409 : 401,
            { error: error.message === 'profile_conflict' ? 'profile_conflict'
              : error.message === 'social_attempt_unavailable' && socialAuth.provider === 'google'
                ? 'SOCIAL_ATTEMPT_UNAVAILABLE' : 'SOCIAL_AUTH_FAILED' });
        }
        const session = sessions.createForPlayer(identity.playerId);
        sessions.revoke(token);
        response.setHeader('Set-Cookie', cookie(session.token, session.maxAge));
        return reply(response, 200, identity);
      }
      if (walletAuth && method === 'POST' && path === '/api/auth/wallet/challenge') {
        if (playerId) return reply(response, 200, walletAuth.challenge(playerId));
        const session = sessions.create();
        response.setHeader('Set-Cookie', cookie(session.token, session.maxAge));
        return reply(response, 200, walletAuth.challenge(session.playerId));
      }
      if (walletAuth && method === 'POST' && path === '/api/auth/wallet/verify') {
        let identity;
        try {
          identity = await walletAuth.verify(await readBody(request), playerId);
        } catch (error) {
          if (error.status) throw error;
          const expected = ['profile_conflict', 'challenge_unavailable', 'invalid_account', 'invalid_public_key', 'invalid_signature', 'wallet_key_unavailable'];
          if (!expected.includes(error.message)) {
            const reason = error.message === 'wallet_rpc_unavailable' ? 'wallet_rpc_unavailable' : error.code ?? error.name;
            console.error('Wallet verification failed', { reason, location: error.stack?.split('\n')[1]?.trim() });
            return reply(response, 503, { error: 'WALLET_AUTH_UNAVAILABLE' });
          }
          if (error.reason && error.message === 'challenge_unavailable') {
            console.info('Wallet challenge rejected', { reason: error.reason });
          }
          return reply(response, error.message === 'profile_conflict' ? 409 : 401, { error: error.message });
        }
        const session = sessions.createForPlayer(identity.playerId);
        sessions.revoke(token);
        response.setHeader('Set-Cookie', cookie(session.token, session.maxAge));
        return reply(response, 200, identity);
      }
      if (method === 'POST' && path === '/api/guest') {
        if (playerId) {
          if (starter) void starter.provision(playerId).catch(() => {});
          return reply(response, 200, { playerId, ...(starter ? { starter: starter.status(playerId) } : {}) });
        }
        const guest = sessions.create();
        response.setHeader('Set-Cookie', cookie(guest.token, guest.maxAge));
        if (starter) void starter.provision(guest.playerId).catch(() => {});
        return reply(response, 201, { playerId: guest.playerId, ...(starter ? { starter: starter.status(guest.playerId) } : {}) });
      }
      if (!playerId) return reply(response, 401, { error: 'SESSION_REQUIRED' });
      if (method === 'GET' && path === '/api/session') {
        return reply(response, 200, { playerId, accountId: walletAuth?.accountForPlayer(playerId) ?? null,
          ...(socialAuth?.linked?.(playerId) ? { social: true } : {}) });
      }
      const shopResponse = await shop?.({ method, path, playerId, readBody: () => readBody(request) });
      if (shopResponse !== undefined) return reply(response, 200, shopResponse);
      if (professions && path === '/api/professions' && method === 'GET') {
        return reply(response, 200, professions.status(playerId));
      }
      if (professions && method === 'POST' && ['/api/professions/record', '/api/professions/select'].includes(path)) {
        const body = await readBody(request);
        try {
          const result = path.endsWith('/record')
            ? await professions.record(playerId, body.runId) : professions.select(playerId, body.specialty);
          return reply(response, 200, result);
        } catch (error) {
          if (['PROFESSION_EXPEDITION_REQUIRED', 'PROFESSION_CHECKPOINT_REQUIRED', 'PROFESSION_LOCKED'].includes(error.message)) {
            return reply(response, 409, { error: error.message });
          }
          throw error;
        }
      }
      const fieldResponse = await field?.({ method, path, accountId: playerId, readBody: () => readBody(request) });
      if (fieldResponse !== undefined) return reply(response, 200, fieldResponse);
      if (starter && path === '/api/starter' && method === 'GET') {
        try {
          const status = await starter.refreshStatus(playerId);
          return reply(response, 200, { ...status, claimAvailable: starter.canClaim() });
        }
        catch { return reply(response, 503, { error: 'STARTER_STATUS_UNAVAILABLE' }); }
      }
      if (starter && path === '/api/starter/provision' && method === 'POST') {
        try {
          const status = await starter.provision(playerId);
          return reply(response, 200, { ...status, claimAvailable: starter.canClaim() });
        }
        catch { return reply(response, 503, { error: 'STARTER_PROVISION_PENDING' }); }
      }
      if (starter && path === '/api/starter/prepare-claim' && method === 'POST') {
        if (!starter.canClaim()) return reply(response, 409, { error: 'STARTER_CLAIM_UNAVAILABLE' });
        const accountId = walletAuth?.accountForPlayer(playerId);
        if (!accountId) return reply(response, 409, { error: 'LINKED_CHAIN_ACCOUNT_REQUIRED' });
        try { return reply(response, 200, await runs.prepareStarterClaim(playerId, accountId)); }
        catch (error) {
          const claimErrors = {
            FINISH_ACTIVE_RUN_BEFORE_CLAIM: 'FINISH_ACTIVE_RUN_BEFORE_CLAIM',
            STARTER_SPEND_PENDING: 'STARTER_SPEND_PENDING',
            starter_link_conflict: 'STARTER_LINK_CONFLICT',
          };
          return reply(response, 409, { error: claimErrors[error.code ?? error.message] ?? 'STARTER_CLAIM_PENDING' });
        }
      }
      if (economy && path.startsWith('/api/economy/')) {
        const accountId = walletAuth?.accountForPlayer(playerId);
        if (!accountId) return reply(response, 409, { error: 'LINKED_CHAIN_ACCOUNT_REQUIRED' });
        try {
          if (method === 'GET' && path === '/api/economy/checkout-methods') {
            return reply(response, 200, checkoutMethods());
          }
          if (method === 'GET' && path === '/api/economy/intents-preview') {
            try { return reply(response, 200, await previewTestnetIntentQuote()); }
            catch { return reply(response, 503, { error: 'INTENTS_PREVIEW_UNAVAILABLE' }); }
          }
          if (marketIndex && method === 'GET' && path === '/api/economy/orders') {
            return reply(response, 200, await marketIndex.list());
          }
          if (marketIndex && method === 'POST' && path === '/api/economy/orders/publish') {
            const { transactionHash } = await readBody(request);
            return reply(response, 200, await marketIndex.publish(accountId, transactionHash));
          }
          if (method === 'GET' && path === '/api/economy/reward-storage') {
            return reply(response, 200, await economy.rewardStorage(accountId));
          }
          if (method === 'GET' && path === '/api/economy/balances') {
            return reply(response, 200, await economy.balances(accountId));
          }
          if (method === 'POST' && path === '/api/economy/prepare-fill') {
            return reply(response, 200, await economy.prepareFill(accountId, await readBody(request)));
          }
          if (method === 'POST' && path === '/api/economy/confirm-fill') {
            return reply(response, 200, await economy.confirmMarketFill(accountId, await readBody(request)));
          }
          if (method === 'POST' && path === '/api/economy/prepare-procurement') {
            return reply(response, 200, await economy.prepareProcurement(accountId, await readBody(request)));
          }
          if (method === 'POST' && path === '/api/economy/prepare-order') {
            return reply(response, 200, economy.prepareMarketOrder(await readBody(request)));
          }
          if (method === 'GET' && path === '/api/economy/charter-stock') {
            const charterId = new URL(request.url, origin).searchParams.get('charterId');
            return reply(response, 200, await economy.charterStock(accountId, charterId));
          }
          if (method === 'POST' && path === '/api/economy/prepare-charter-order' && process.env.VEILBOUND_CHARTER_MARKET_ENABLED === 'true') {
            return reply(response, 200, await economy.prepareCharterOrder(accountId, await readBody(request)));
          }
          if (method === 'POST' && path === '/api/economy/prepare-cancel') {
            return reply(response, 200, await economy.prepareMarketCancel(accountId, await readBody(request)));
          }
          if (method === 'GET' && path === '/api/economy/craft-quote') {
            const recipeId = new URL(request.url, origin).searchParams.get('recipeId');
            return reply(response, 200, await economy.craftQuote(accountId, recipeId));
          }
          if (method === 'POST' && path === '/api/economy/prepare-craft') {
            const input = await readBody(request);
            if (input.workshop !== undefined) professions?.authorizeCraft(playerId, input);
            if (input.workshop === 'specialty' && !professions) {
              return reply(response, 409, { error: 'PROFESSION_SPECIALTY_REQUIRED' });
            }
            return reply(response, 200, economy.prepareCraft(input));
          }
          if (method === 'POST' && path === '/api/economy/prepare-craft-order') {
            return reply(response, 200, await economy.prepareCraftOrder(accountId, await readBody(request)));
          }
          if (method === 'POST' && path === '/api/economy/prepare-craft-order-action') {
            return reply(response, 200, await economy.prepareCraftOrderAction(accountId, await readBody(request)));
          }
          if (method === 'POST' && path === '/api/economy/prepare-nft-sale') {
            return reply(response, 200, await economy.prepareNftSale(accountId, await readBody(request)));
          }
          if (method === 'GET' && path === '/api/economy/listing-inventory') {
            const cursor = new URL(request.url, origin).searchParams.get('cursor') ?? '0';
            return reply(response, 200, await economy.listingInventory(accountId, cursor));
          }
          if (method === 'POST' && path === '/api/economy/nft-sales/confirm') {
            return reply(response, 200, await economy.confirmNftSale(accountId, await readBody(request)));
          }
          if (method === 'GET' && path === '/api/economy/nft-sales') {
            const query = new URL(request.url, origin).searchParams;
            return reply(response, 200, await economy.nftSales({
              cursor: query.get('cursor') ?? '0', limit: Number(query.get('limit') ?? '12'),
            }));
          }
          if (method === 'GET' && path === '/api/economy/nft-sale-credit') {
            return reply(response, 200, await economy.nftSaleCredit(accountId));
          }
          if (method === 'POST' && path === '/api/economy/prepare-nft-sale-withdrawal') {
            return reply(response, 200, await economy.prepareNftSaleWithdrawal(accountId));
          }
          if (method === 'POST' && path === '/api/economy/prepare-nft-rental') {
            return reply(response, 200, await economy.prepareNftRental(accountId, await readBody(request)));
          }
          if (method === 'GET' && path === '/api/economy/guild-treasury') {
            const guildId = new URL(request.url, origin).searchParams.get('guildId');
            return reply(response, 200, await economy.guildTreasury(guildId));
          }
          if (method === 'GET' && path === '/api/economy/guild-payment') {
            const query = new URL(request.url, origin).searchParams;
            return reply(response, 200, await economy.guildPayment(query.get('guildId'), query.get('paymentId')));
          }
          if (method === 'GET' && path === '/api/economy/companion-bond') {
            const tokenId = new URL(request.url, origin).searchParams.get('tokenId');
            return reply(response, 200, await economy.companionBond(tokenId));
          }
          if (method === 'GET' && path === '/api/economy/nft-rental') {
            const tokenId = new URL(request.url, origin).searchParams.get('tokenId');
            return reply(response, 200, await economy.nftRental(tokenId));
          }
          if (method === 'POST' && path === '/api/economy/prepare-guild-action') {
            return reply(response, 200, economy.prepareGuildAction(await readBody(request)));
          }
          const artifactRoute = /^\/api\/economy\/artifacts\/([A-Za-z0-9_:.-]{1,96})$/.exec(path);
          if (method === 'GET' && artifactRoute) {
            const itemIds = new URL(request.url, origin).searchParams.getAll('item');
            return reply(response, 200, itemIds.length
              ? await economy.nftSaleSnapshot(artifactRoute[1], itemIds) : await economy.artifact(artifactRoute[1]));
          }
        } catch (error) {
          if (error.status) throw error;
          if (error.message === 'PROFESSION_SPECIALTY_REQUIRED') {
            return reply(response, 409, { error: error.message });
          }
          return reply(response, 409, { error: 'ECONOMIC_OPERATION_UNAVAILABLE' });
        }
      }
      if (method === 'POST' && path === '/api/logout') {
        sessions.revoke(token);
        response.setHeader('Set-Cookie', cookie('', 0));
        return reply(response, 200, { ok: true });
      }
      if (path === '/api/runs/prepare-nft-lock' && method === 'POST') {
        const accountId = walletAuth?.accountForPlayer(playerId);
        if (!economy || !accountId) return reply(response, 409, { error: 'NFT_LOADOUT_UNAVAILABLE' });
        const { tokenId, operationId } = await readBody(request);
        const runId = runs.expeditionRunId(playerId, operationId);
        try { return reply(response, 200, { runId, transaction: await economy.prepareNftRunLock(accountId, tokenId, runId) }); }
        catch { return reply(response, 409, { error: 'NFT_LOADOUT_UNAVAILABLE' }); }
      }
      if (path === '/api/runs' && method === 'POST') {
        const { talisman, operationId, mode = 'practice', chronicleToken, purseAtomic, relicToken, companionToken } = await readBody(request);
        if (chronicleToken !== undefined && (!chronicle || mode !== 'expedition' || typeof chronicleToken !== 'string')) {
          return reply(response, 409, { error: 'CHRONICLE_BINDING_UNAVAILABLE' });
        }
        const chronicleBinding = chronicleToken === undefined ? undefined : await chronicle.bind(playerId, chronicleToken);
        let nftBinding;
        if (relicToken !== undefined || companionToken !== undefined) {
          const accountId = walletAuth?.accountForPlayer(playerId);
          if (!economy || !accountId || !['practice', 'expedition'].includes(mode) ||
              [relicToken, companionToken].some(id => id !== undefined && (typeof id !== 'string' || !id))) {
            return reply(response, 409, { error: 'NFT_LOADOUT_UNAVAILABLE' });
          }
          const runId = mode === 'expedition' ? runs.expeditionRunId(playerId, operationId) : undefined;
          try { nftBinding = await economy.bindRunNfts(accountId, { relicToken, companionToken, runId }); }
          catch { return reply(response, 409, { error: 'NFT_LOADOUT_UNAVAILABLE' }); }
        }
        return reply(response, 200, await runs.start(playerId, { mode, talisman, operationId, chronicleBinding, purseAtomic, nftBinding }));
      }
      if (path === '/api/runs/loadout-capabilities' && method === 'GET') {
        return reply(response, 200, { ...runs.loadoutCapabilities?.(), chronicle: Boolean(chronicle) });
      }
      if (path === '/api/runs/expedition-inventory' && method === 'GET') {
        const accountId = walletAuth?.accountForPlayer(playerId);
        if (!economy || !accountId) return reply(response, 409, { error: 'NFT_LOADOUT_UNAVAILABLE' });
        const offset = new URL(request.url, origin).searchParams.get('offset') ?? '0';
        try { return reply(response, 200, await economy.expeditionInventory(accountId, offset)); }
        catch { return reply(response, 503, { error: 'NFT_INVENTORY_UNAVAILABLE' }); }
      }
      if (path === '/api/runs/expedition-history' && method === 'GET') {
        return reply(response, 200, await runs.expeditionHistory(playerId));
      }
      if (path === '/api/runs/active' && method === 'GET') return reply(response, 200, await runs.active(playerId));
      const supplyRoute = /^\/api\/runs\/([\w-]+)\/supply-status$/.exec(path);
      if (supplyRoute && method === 'GET') {
        return reply(response, 200, await runs.supplyStatus(playerId, supplyRoute[1]));
      }
      const purseRoute = /^\/api\/runs\/([\w-]+)\/vault-purse\/(prepare|confirm|cancel|close)$/.exec(path);
      if (purseRoute && method === 'POST') {
        const [, runId, action] = purseRoute;
        const body = await readBody(request);
        if (action === 'prepare') return reply(response, 200, await runs.prepareVaultPurse(playerId, runId, body.amountAtomic));
        if (action === 'close') return reply(response, 200, await runs.prepareVaultPurseClose(playerId, runId));
        return reply(response, 200, await runs.confirmVaultPurse(playerId, runId, { cancel: action === 'cancel' }));
      }
      const materialRoute = /^\/api\/runs\/([\w-]+)\/materials$/.exec(path);
      if (materialRoute && method === 'GET') return reply(response, 200, await runs.materialBank(playerId, materialRoute[1]));
      const materialClaimRoute = /^\/api\/runs\/([\w-]+)\/prepare-material-claim$/.exec(path);
      if (materialClaimRoute && method === 'POST') {
        const { entitlementId } = await readBody(request);
        return reply(response, 200, await runs.prepareMaterialClaim(playerId, materialClaimRoute[1], entitlementId));
      }
      const evolutionRoute = /^\/api\/runs\/([\w-]+)\/quote-evolution$/.exec(path);
      if (evolutionRoute && method === 'POST' && chronicle) {
        const { achievement } = await readBody(request);
        return reply(response, 200, await chronicle.evolution(playerId, evolutionRoute[1], achievement));
      }
      const chronicleRoute = /^\/api\/runs\/([\w-]+)\/prepare-chronicle$/.exec(path);
      if (chronicleRoute && method === 'POST' && chronicle) {
        const { achievement } = await readBody(request);
        return reply(response, 200, await chronicle.prepare(playerId, chronicleRoute[1], achievement));
      }
      const inventoryRoute = /^\/api\/runs\/([\w-]+)\/owned-items\/(prepare|confirm|cancel|close)$/.exec(path);
      if (inventoryRoute && method === 'POST') {
        const [, runId, action] = inventoryRoute;
        const methods = { prepare: 'prepareOwnedItems', confirm: 'confirmOwnedItems', cancel: 'cancelOwnedItems', close: 'prepareOwnedItemsClose' };
        const body = await readBody(request);
        return reply(response, 200, await runs[methods[action]](playerId, runId, body.items));
      }
      const route = /^\/api\/runs\/([\w-]+)(?:\/(actions|replay|prepare-bank))?$/.exec(path);
      if (route && method === 'GET' && !route[2]) return reply(response, 200, await runs.get(playerId, route[1]));
      const shareRun = /^\/api\/runs\/([\w-]+)\/share-journey$/.exec(path);
      if (journeys && shareRun && method === 'POST') return reply(response, 200, await journeys.publish(playerId, shareRun[1]));
      if (route?.[2] === 'replay' && method === 'GET') return reply(response, 200, await runs.replay(playerId, route[1]));
      if (route?.[2] === 'prepare-bank' && method === 'POST') {
        const body = await readBody(request);
        if (Object.keys(body).length !== 1 || !Number.isSafeInteger(body.region)) {
          return reply(response, 400, { error: 'INVALID_BANK_REQUEST' });
        }
        return reply(response, 200, await runs.prepareBank(playerId, route[1], body.region));
      }
      if (route?.[2] === 'actions' && method === 'POST') {
        const result = await runs.act(playerId, route[1], await readBody(request));
        if (result.mode === 'expedition' && result.checkpoints?.length && field?.settleCompleted) {
          void field.settleCompleted(playerId, route[1]).catch(() => {});
        }
        return reply(response, 200, result);
      }
      if (modes && path.startsWith('/api/modes/') && ['GET', 'POST'].includes(method)) {
        const result = await modes.route({
          method, path, accountId: playerId, body: method === 'POST' ? await readBody(request) : undefined,
        });
        if (result !== undefined) return reply(response, 200, result);
      }
      return reply(response, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 503) {
        return reply(response, error.status, { error: error.code ?? 'REQUEST_FAILED' });
      }
      return reply(response, 500, { error: 'SERVER_ERROR' });
    }
  });
  if (modes) {
    server.closeRealtime = attachRealtime(server, { origin, modes, sessions, getToken });
    server.once('close', server.closeRealtime);
  }
  return server;
}



