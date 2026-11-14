import {map,regionOf} from './expedition-data.mjs';

export const talismans=[
  {id:'gate',name:'Gate Talisman',squad:'The Gate Wardens',line:'Rook holds the line while Mara and Elian work from behind.',order:['rook','mara','elian','tess'],art:'wood-orchard-threshold-v1.png'},
  {id:'river',name:'River Talisman',squad:'The River Watch',line:'Mara leads the crossing with Tess and Elian.',order:['mara','tess','elian','rook'],art:'wood-resin-creek-v1.png'},
  {id:'lantern',name:'Lantern Talisman',squad:'The Lantern Road',line:'Elian leads Tess and Rook through the dark.',order:['elian','tess','rook','mara'],art:'wood-doorless-house-v1.png'},
];

export const xpRewards=[
  {xp:60,label:'Reed Salve at the start of each run',token:'salve'},
  {xp:120,label:'Bark Ward at the start of each run',token:'guard-token'},
  {xp:200,label:'Clearwater Seal at the start of each run',token:'purify-token'},
];

export const trials=[
  'Standard expedition.',
  'Extra enemy die. Reroll unused dice once each turn.',
  'Regular foes gain +25% Max HP and +1 STR. Your first warden is Iridescent.',
  'Boss starts with Guard. Your starting dice improve.',
  'Stronger extra enemy die. Start with Heal-All and Full Heal-All tokens.',
  'All starting wardens are Iridescent. Boss recovery is reduced to 50%.',
  'Boss gains +25% Max HP and +1 STR. Start with 15 Copper.',
  'Regular foes may be Iridescent. Start with a Bark Shield.',
  'Regular foes now gain +33% Max HP and +2 STR.',
  'The extra enemy die improves again. Wardens start battles with Relentless.',
  'Boss gains +33% Max HP and +2 STR. Start with 30 Copper. Boss recovery falls to 0% and revival to 1%.',
  'The boss is Iridescent. All route names are visible.',
];
export const trialLabel=level=>level?'Trial '+['','I','II','III','IV','V','VI','VII','VIII','IX','X','XI'][level]:'Standard';

export const freshProgress=()=>({talismans:{},receipts:{}});
export const talismanStats=(progress,id)=>progress.talismans[id]??{xp:0,wins:0,bestTrial:0};
export function talismanUnlocked(progress,id){
  const index=talismans.findIndex(talisman=>talisman.id===id);
  return index===0||index>0&&talismanStats(progress,talismans[index-1].id).wins>0;
}
export function maxTrial(progress,id){
  if(!talismanUnlocked(progress,id)||!Object.values(progress.talismans).some(stats=>stats.wins>0))return 0;
  return Math.min(trials.length-1,talismanStats(progress,id).bestTrial+1);
}

const nodeXp={road:10,cache:10,bridge:10,graft:20,sanctum:50};
const regionalXp={battle:10,coin:10,elite:20,boss:50};
export function settleRun(progress,run){
  if(!run.runId||!['complete','defeat'].includes(run.phase)||!talismans.some(talisman=>talisman.id===run.talisman))return null;
  if(Object.hasOwn(progress.receipts,run.runId))return progress.receipts[run.runId];
  const id=run.talisman;
  const trial=run.trial??0;
  const before=talismanStats(progress,id);
  const openBefore=talismans.filter(talisman=>talismanUnlocked(progress,talisman.id)).map(talisman=>talisman.id);
  const trialBefore=maxTrial(progress,id);
  const won=run.phase==='complete';
  const xp=[...new Set(run.visited)].reduce((total,id)=>{
    const node=map[id];
    return total+(regionOf(node).number>1?regionalXp[node.type]??0:nodeXp[id]??0);
  },0);
  const after={xp:before.xp+xp,wins:before.wins+(won?1:0),bestTrial:won?Math.max(before.bestTrial,trial):before.bestTrial};
  progress.talismans[id]=after;
  const unlocked=xpRewards.filter(reward=>reward.xp>before.xp&&reward.xp<=after.xp).map(reward=>reward.label);
  for(const talisman of talismans)if(!openBefore.includes(talisman.id)&&talismanUnlocked(progress,talisman.id))unlocked.push(talisman.name);
  if(maxTrial(progress,id)>trialBefore)unlocked.push(trialLabel(maxTrial(progress,id)));
  const receipt={xp,totalXp:after.xp,trial,unlocked};
  progress.receipts[run.runId]=receipt;
  return receipt;
}

