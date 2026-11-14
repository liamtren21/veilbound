import { readFile } from 'node:fs/promises';
import { map } from '../../../expedition-data.mjs';
import { createFieldRewardFunder } from '../chain/field.mjs';
import { createFieldOperator } from '../chain/field-operator.mjs';
import { openFieldContracts } from './field.mjs';

const id = /^[a-z0-9][a-z0-9-]{0,63}$/;
const account = /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet|[a-f0-9]{64})$/;
const maxU128 = (1n << 128n) - 1n;
const maxU64 = (1n << 64n) - 1n;

export function validateFieldOffers(offers) {
  if (!Array.isArray(offers) || !offers.length || offers.length > 50) throw new Error('invalid_field_offers');
  const ids = new Set();
  return offers.map(offer => {
    if (typeof offer?.id !== 'string' || !id.test(offer.id) || ids.has(offer.id) ||
        !Object.hasOwn(map, offer.objective) || map[offer.objective].type !== 'elite' ||
        !Object.hasOwn(map, offer.delivery) || map[offer.delivery].type !== 'boss' ||
        typeof offer.rewardAtomic !== 'string' || !/^[1-9]\d{0,38}$/.test(offer.rewardAtomic) ||
        BigInt(offer.rewardAtomic) > maxU128 || !Number.isSafeInteger(offer.endsAt) || offer.endsAt < 1 ||
        BigInt(offer.endsAt) * 1_000_000n > maxU64) throw new Error('invalid_field_offer');
    ids.add(offer.id);
    return { id: offer.id, objective: offer.objective, delivery: offer.delivery, rewardAtomic: offer.rewardAtomic, endsAt: offer.endsAt };
  });
}

export async function bootstrapFieldContracts({
  env = process.env, file, runs, beneficiaryFor, now = Date.now,
  openOperator = createFieldOperator, loadOffers = path => readFile(path, 'utf8'),
}) {
  const coreId = env.VEILBOUND_CORE_ID;
  const operatorId = env.VEILBOUND_FIELD_OPERATOR_ID;
  const keyPath = env.VEILBOUND_FIELD_OPERATOR_KEY_PATH;
  const offersPath = env.VEILBOUND_FIELD_OFFERS_PATH;
  if (![operatorId, keyPath, offersPath].some(Boolean)) return undefined;
  if (![operatorId, keyPath, offersPath, coreId].every(Boolean) || !account.test(coreId) ||
      !account.test(operatorId) || coreId.length > 64 || operatorId.length > 64 || operatorId === coreId ||
      typeof runs?.verifyProgress !== 'function' || typeof beneficiaryFor !== 'function') {
    throw new Error('incomplete_field_contract_configuration');
  }
  const offers = validateFieldOffers(JSON.parse(await loadOffers(offersPath)));
  const chain = await openOperator({ operatorId, coreId, keyPath });
  const funder = createFieldRewardFunder({ coreId, operatorId, beneficiaryFor, now, ...chain });
  return openFieldContracts(file, { runs, funder, offers, now });
}

