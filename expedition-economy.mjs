export function copperForKill(base,nodeType,region){
  if(nodeType==='boss')return base+4+region;
  if(nodeType==='elite')return Math.max(base,8)+2+region;
  if(nodeType==='coin')return base+2;
  return base;
}

export function canAffordCopper(state,price){
  return Number.isSafeInteger(price)&&price>=0&&Number.isSafeInteger(state.copper)&&state.copper>=price;
}

export function mergeLegacyWallet(state){
  const copper=Number.isSafeInteger(state.copper)&&state.copper>=0?state.copper:0;
  const marks=Number.isSafeInteger(state.marks)&&state.marks>0?state.marks:0;
  state.copper=copper+Math.min(Number.MAX_SAFE_INTEGER-copper,3*marks);
  delete state.marks;
  if(state.battle)delete state.battle.marksEarned;
}

// Save files and replay hashes retain the original currency field and event text.
export function runCurrencyCopy(text = ''){
  return text.replace(/\b(?:Run )?Copper\b/g,'Crowns');
}
