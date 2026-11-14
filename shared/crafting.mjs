const recipes = [{
  id: 'apothecary-ward-v1', version: 1, specialty: 'apothecary',
  inputs: { salt: 2, resin: 1 },
  output: { itemId: 'ward', quantity: 1 }, copperAtomic: '400',
}, {
  id: 'relicsmith-inlay-v1', version: 1, specialty: 'relicsmith',
  inputs: { iron: 2, resin: 1 },
  output: { itemId: 'relic-inlay', quantity: 1 }, copperAtomic: '600',
}, {
  id: 'binder-binding-v1', version: 1, specialty: 'binder',
  inputs: { thread: 2, resin: 1 },
  output: { itemId: 'binding', quantity: 1 }, copperAtomic: '500',
}];

export function craftingCatalog() {
  return structuredClone(recipes);
}

export function recipeFor(id, version) {
  const recipe = recipes.find(row => row.id === id && row.version === version);
  if (!recipe) throw new Error('unknown_recipe');
  return structuredClone(recipe);
}

export function selectSpecialty(profession, specialty) {
  if (!profession.unlocked?.includes(specialty)) throw new Error('specialty_locked');
  return { ...profession, active: specialty };
}

export function prepareCraft({ recipeId, version, lots, profession, workshop }) {
  const recipe = recipeFor(recipeId, version);
  if (workshop !== 'public' && profession?.active !== recipe.specialty) throw new Error('specialty_required');
  if (!Array.isArray(lots) || !lots.length) throw new Error('missing_materials');
  const totals = {};
  const ids = new Set();
  for (const lot of lots) {
    if (lot.provenance !== 'settled') throw new Error('unsettled_material');
    if (!lot.id || ids.has(lot.id) || !Number.isSafeInteger(lot.quantity) || lot.quantity <= 0) throw new Error('invalid_material');
    ids.add(lot.id);
    totals[lot.itemId] = (totals[lot.itemId] ?? 0) + lot.quantity;
    if (!Number.isSafeInteger(totals[lot.itemId])) throw new Error('invalid_material');
  }
  for (const [item, quantity] of Object.entries(recipe.inputs)) {
    if ((totals[item] ?? 0) < quantity) throw new Error('missing_materials');
  }
  return { recipeId, version, inputs: recipe.inputs, output: recipe.output, copperAtomic: recipe.copperAtomic };
}
