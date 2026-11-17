import { openJourneyShares } from './runs/journey-shares.mjs';
import { readFileSync } from 'node:fs';
import { openLocalStarterChain } from './economy/local-starter-chain.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openGuestSessions } from './auth/guest.mjs';
import { openWalletAuth } from './auth/wallet.mjs';
import { openSocialAuth } from './auth/social.mjs';
import { openNearSocialAuth } from './auth/near-social.mjs';
import { createLocalNearSocialSponsor, createNearSocialSponsor } from './auth/near-social-relayer.mjs';
import { createCoreClient } from './chain/core.mjs';
import { createOnboardingChain } from './chain/onboarding.mjs';
import { openStarterGrants } from './economy/starter-grants.mjs';
import { bootstrapRunRewards, loadRewardSigningKey } from './economy/reward-bootstrap.mjs';
import { createGameServer } from './http.mjs';
import { createPublicGame } from './public-game.mjs';
import { createObservability } from './observability.mjs';
import { openRuns } from './runs/service.mjs';
import { createOwnedItems } from './runs/owned-items.mjs';
import { createVaultPurse } from './runs/vault-purse.mjs';
import { createMaterialClaims } from './runs/material-claims.mjs';
import { readFile } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { openProfessions } from './progression/professions.mjs';
import { createChronicle } from './progression/chronicle.mjs';
import { openMarketIndex } from './orders/market-index.mjs';
import { createShopQuotes, createShopRoutes } from './npc/shop-operator.mjs';
import { createShopSnapshotReader } from './chain/shop-snapshot.mjs';
import { bootstrapFieldContracts } from './orders/field-bootstrap.mjs';
import { createFieldRoutes } from './orders/field-http.mjs';
import { openGameModes } from './modes/service.mjs';
import { expeditionModeCombat, gameModeConfig } from './modes/config.mjs';

const directory = resolve(process.env.VEILBOUND_DATA_DIR ?? '.veilbound-local');
const port = Number(process.env.VEILBOUND_PORT ?? 8787);
const bind = process.env.VEILBOUND_BIND ?? '127.0.0.1';
const origin = process.env.VEILBOUND_ORIGIN ?? `http://127.0.0.1:${port}`;
if (bind !== '127.0.0.1' && new URL(origin).protocol !== 'https:') throw new Error('Public API requires an HTTPS origin');
const telemetry = createObservability({ enabled: process.env.VEILBOUND_TELEMETRY === 'true' });
mkdirSync(directory, { recursive: true });
const sessions = openGuestSessions(resolve(directory, 'sessions.sqlite'));
const walletAuth = openWalletAuth(resolve(directory, 'wallet-auth.sqlite'), { recipient: new URL(origin).host });
if (Boolean(process.env.VEILBOUND_CORE_ID) !== Boolean(process.env.VEILBOUND_COPPER_ID)) {
  throw new Error('Configure both VEILBOUND_CORE_ID and VEILBOUND_COPPER_ID');
}
const economy = process.env.VEILBOUND_CORE_ID ? createCoreClient({
  coreId: process.env.VEILBOUND_CORE_ID, copperId: process.env.VEILBOUND_COPPER_ID,
}) : undefined;
const onboardingKeyPath = process.env.VEILBOUND_ONBOARDING_KEY_PATH;
const onboardingKeyValue = process.env.VEILBOUND_ONBOARDING_KEY;
const starterChain = onboardingKeyPath || onboardingKeyValue ? await createOnboardingChain({
  rootAccountId: process.env.VEILBOUND_ROOT_ID,
  coreId: process.env.VEILBOUND_CORE_ID,
  keyPath: onboardingKeyPath, keyValue: onboardingKeyValue,
}) : undefined;
const localStarterEnabled = process.env.VEILBOUND_LOCAL_STARTER === 'true';
if (localStarterEnabled && (starterChain || bind !== '127.0.0.1' ||
    !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname))) {
  throw new Error('Local Starter Pack requires a loopback server and a separate local data directory');
}
const localStarter = localStarterEnabled ? openLocalStarterChain(resolve(directory, 'local-starter.sqlite')) : undefined;
const starter = openStarterGrants(resolve(directory, 'starter.sqlite'), { chain: starterChain ?? localStarter,
  relicIds: localStarter ? Array.from({ length: 32 }, (_, index) => 'local-starter-' + (index + 1)) : (process.env.VEILBOUND_STARTER_RELIC_IDS ?? '').split(',').filter(Boolean) });
const googleOAuthFile = process.env.VEILBOUND_GOOGLE_OAUTH_FILE;
const googleOAuthJson = process.env.VEILBOUND_GOOGLE_OAUTH_JSON;
const googleOAuthSource = googleOAuthJson ?? (googleOAuthFile ? readFileSync(googleOAuthFile, 'utf8') : undefined);
const googleOAuth = googleOAuthSource ? JSON.parse(googleOAuthSource).web : undefined;
if (googleOAuthSource !== undefined && (!googleOAuth?.client_id || !googleOAuth.client_secret)) {
  throw new Error('Expected a Google OAuth Web application credentials file');
}
const socialAuth = googleOAuth ? openSocialAuth(resolve(directory, 'google-auth.sqlite'), {
  provider: 'google', issuer: 'https://accounts.google.com', clientId: googleOAuth.client_id,
  clientSecret: googleOAuth.client_secret, redirectUri: new URL('/google-callback.html', origin).href,
}) : process.env.VEILBOUND_AUTH0_CLIENT_ID ? openSocialAuth(resolve(directory, 'social-auth.sqlite'), {
  issuer: process.env.VEILBOUND_AUTH0_ISSUER,
  clientId: process.env.VEILBOUND_AUTH0_CLIENT_ID,
  redirectUri: process.env.VEILBOUND_AUTH0_REDIRECT_URI,
  clientSecret: process.env.VEILBOUND_AUTH0_CLIENT_SECRET,
}) : undefined;
const nearAuthClientId = process.env.VEILBOUND_NEAR_AUTH_CLIENT_ID;
const nearAuthRelayerUrl = process.env.VEILBOUND_NEAR_AUTH_RELAYER_URL;
const nearAuthDailyLimit = process.env.VEILBOUND_NEAR_AUTH_DAILY_LIMIT;
const nearAuthLocal = process.env.VEILBOUND_NEAR_AUTH_LOCAL_SIGNER === 'true';
if (nearAuthLocal && (bind !== '127.0.0.1' || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname))) {
  throw new Error('The local NEAR Auth signer requires a loopback application origin');
}
if (nearAuthLocal && nearAuthRelayerUrl) throw new Error('Choose one NEAR Auth relayer');
const nearSocialAuth = [nearAuthClientId, nearAuthRelayerUrl, nearAuthDailyLimit, nearAuthLocal].some(Boolean)
  ? openNearSocialAuth(resolve(directory, 'near-social-auth.sqlite'), {
    walletAuth, clientId: nearAuthClientId, dailyLimit: Number(nearAuthDailyLimit),
    sponsor: nearAuthLocal ? await createLocalNearSocialSponsor({
      accountId: process.env.VEILBOUND_NEAR_AUTH_RELAYER_ACCOUNT,
      keyPath: process.env.VEILBOUND_NEAR_AUTH_RELAYER_KEY_PATH,
    }) : createNearSocialSponsor({ relayerUrl: nearAuthRelayerUrl }),
  }) : undefined;
const modeSecretHex = process.env.VEILBOUND_MODE_SECRET;
if (modeSecretHex && !/^[0-9a-f]{64}$/i.test(modeSecretHex)) throw new Error('VEILBOUND_MODE_SECRET must be 64 hexadecimal characters');
const modeSecret = modeSecretHex ? Buffer.from(modeSecretHex, 'hex') : undefined;
const rewards = await bootstrapRunRewards({
  file: resolve(directory, 'run-rewards.sqlite'),
  beneficiaryForPlayer: playerId => walletAuth.accountForPlayer(playerId),
});
const ownedItems = process.env.VEILBOUND_RUN_ITEMS_ENABLED === 'true' && rewards && economy ? createOwnedItems({
  coreId: process.env.VEILBOUND_CORE_ID,
  ruleset: JSON.parse(await readFile(process.env.VEILBOUND_REWARD_CONFIG_PATH ??
    new URL('../../deployments/testnet.config.json', import.meta.url), 'utf8')).ruleset,
  privateKey: await loadRewardSigningKey(),
  readReservation: receipt => economy.runItemReservation(receipt),
}) : undefined;
const materialClaims = process.env.VEILBOUND_MATERIAL_CLAIMS_ENABLED === 'true' && rewards && economy ? createMaterialClaims({
  contractId: process.env.VEILBOUND_CORE_ID,
  ruleset: JSON.parse(await readFile(process.env.VEILBOUND_REWARD_CONFIG_PATH ??
    new URL('../../deployments/testnet.config.json', import.meta.url), 'utf8')).ruleset,
  privateKey: await loadRewardSigningKey(),
  readBudget: tokenId => economy.materialBudget(tokenId), readClaim: id => economy.materialClaim(id),
}) : undefined;
const vaultPurse = process.env.VEILBOUND_VAULT_PURSE_ENABLED === 'true' && rewards && economy ? createVaultPurse({
  contractId: process.env.VEILBOUND_CORE_ID,
  ruleset: JSON.parse(await readFile(process.env.VEILBOUND_REWARD_CONFIG_PATH ??
    new URL('../../deployments/testnet.config.json', import.meta.url), 'utf8')).ruleset,
  privateKey: await loadRewardSigningKey(),
  readPurse: (accountId, runId) => economy.runPurse(accountId, runId),
}) : undefined;
const runs = openRuns(resolve(directory, 'runs.sqlite'), { modeSecret, rewards, ownedItems, materialClaims, vaultPurse, allowNewVaultPurse: false, starter });
const chronicle = process.env.VEILBOUND_CHRONICLE_ENABLED === 'true' && rewards && economy ? createChronicle({
  coreId: process.env.VEILBOUND_CORE_ID,
  ruleset: JSON.parse(await readFile(process.env.VEILBOUND_REWARD_CONFIG_PATH ??
    new URL('../../deployments/testnet.config.json', import.meta.url), 'utf8')).ruleset,
  privateKey: await loadRewardSigningKey(),
  economy, runs, accountForPlayer: playerId => walletAuth.accountForPlayer(playerId),
}) : undefined;
const professions = openProfessions(resolve(directory, 'professions.sqlite'), { runs });
const marketIndex = economy ? openMarketIndex(resolve(directory, 'market.sqlite'), {
  coreId: process.env.VEILBOUND_CORE_ID, economy,
}) : undefined;
const shopItems = ['salt', 'resin', 'salve', 'ward'];
const shop = economy ? createShopRoutes({ accountForPlayer: playerId => walletAuth.accountForPlayer(playerId),
  service: createShopQuotes({ core: economy,
    readSnapshot: createShopSnapshotReader({ coreId: process.env.VEILBOUND_CORE_ID, epoch: 1 }),
    policy: { epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER, methods: ['buy', 'sell'], itemIds: shopItems,
      maxQuantity: 4, maxUnitPriceAtomic: '1000', budgetRemainingAtomic: '10000',
      targetStock: Object.fromEntries(shopItems.map(id => [id, 4])) },
    pricing: Object.fromEntries(shopItems.map((id, index) => [id, { anchorAtomic: String([100, 120, 240, 450][index]),
      spreadBps: 1000, stockImpactBps: 2000 }])),
  }),
}) : undefined;
const fieldContracts = await bootstrapFieldContracts({
  file: resolve(directory, 'field-contracts.sqlite'), runs,
  beneficiaryFor: playerId => walletAuth.accountForPlayer(playerId),
});
const modes = openGameModes(resolve(directory, 'modes.sqlite'), {
  runs, combat: expeditionModeCombat(runs), ...gameModeConfig(process.env),
});
const serveGame = process.env.VEILBOUND_PUBLIC_DIR ? createPublicGame(resolve(process.env.VEILBOUND_PUBLIC_DIR)) : undefined;
const journeys = openJourneyShares(resolve(directory, 'journey-shares.sqlite'), runs);
const server = createGameServer({ sessions, runs, journeys, modes, field: createFieldRoutes(fieldContracts), professions, marketIndex, shop, chronicle, walletAuth, socialAuth, nearSocialAuth, economy, starter, telemetry, serveGame, origin, secureCookies: new URL(origin).protocol === 'https:' });
server.listen(port, bind, () => console.log(`VEILBOUND API listening on ${bind}:${server.address().port}`));
let fieldRecovery;
const fieldRecoveryTimer = fieldContracts && setInterval(() => {
  fieldRecovery ??= fieldContracts.recoverDue().then(() => telemetry?.recordOperation('field_recovery', 'success')).catch(error => {
    telemetry?.recordOperation('field_recovery', 'error');
    console.error('Field recovery unavailable', error.code ?? error.name);
  }).finally(() => { fieldRecovery = undefined; });
}, 15_000);
fieldRecoveryTimer?.unref();
const shutdown = () => {
  clearInterval(fieldRecoveryTimer);
  server.closeRealtime?.();
  server.close(async () => {
    await fieldRecovery;
    modes.close();
    fieldContracts?.close();
    sessions.close();
    walletAuth.close();
    starter.close();
    localStarter?.close();
    socialAuth?.close();
    nearSocialAuth?.close();
    journeys.close();
    runs.close();
    professions.close();
    marketIndex?.close();
    rewards?.close();
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
