import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recipeFor } from '../../shared/crafting.mjs';

test('gameplay craft catalog matches every recipe prepared for deployed testnet', () => {
  const setup = JSON.parse(readFileSync(new URL('../../deployments/testnet.setup.unsigned.json', import.meta.url)));
  const actions = setup.batches.flatMap(batch => batch.actions).filter(action => action.params.methodName === 'register_recipe');
  assert.equal(actions.length, 3);
  for (const { params: { args } } of actions) {
    const catalog = recipeFor(args.recipe_id, 1);
    assert.deepEqual(catalog.inputs, Object.fromEntries(args.recipe.input_ids.map((id, i) => [id, Number(args.recipe.input_amounts[i])])));
    assert.deepEqual(catalog.output, { itemId: args.recipe.output_id, quantity: Number(args.recipe.output_amount) });
    assert.equal(catalog.copperAtomic, args.recipe.copper_cost);
  }
});
