/** Pure curse operations: no RNG, UI, timers, or permanent stat changes. */
export const CURSE_DEFINITIONS=Object.freeze({
  withered:Object.freeze({id:'withered',name:'Withered',reductions:Object.freeze([0,.15,.25,.35])}),
  brittle:Object.freeze({id:'brittle',name:'Brittle',reductions:Object.freeze([0,.15,.25,.35])}),
  'blood-debt':Object.freeze({id:'blood-debt',name:'Blood Debt'}),
});
export const CURSE_IDS=Object.freeze(Object.keys(CURSE_DEFINITIONS));
const sourceTypes=new Set(['gear','encounter','event']);
const natural=source=>source.sourceType!=='gear';
const sources=hero=>Array.isArray(hero?.curseSources)?hero.curseSources:[];
const validSource=(source,{requireOrder=false}={})=>Boolean(source&&CURSE_IDS.includes(source.curseId)&&Number.isInteger(source.tier)&&source.tier>=1&&source.tier<=3&&sourceTypes.has(source.sourceType)&&typeof source.sourceId==='string'&&source.sourceId.length>0&&(!requireOrder&&source.order===undefined||Number.isSafeInteger(source.order)&&source.order>=0));
const result=(changed=false,reason=null,extra={})=>({changed,blocked:false,reason,...extra});
const identity=source=>JSON.stringify([source.curseId,source.sourceType,source.sourceId]);

export function effectiveTier(hero,curseId,{naturalOnly=false}={}) {
 return sources(hero).filter(s=>s.curseId===curseId&&(!naturalOnly||natural(s))).reduce((tier,s)=>Math.max(tier,s.tier),0);
}

/** Natural encounter caps and Ward need a persisted battle object supplied by the caller. */
export function applyCurse(hero,source,{battle,inBattle=false,encounterId}={}) {
 if(!hero||!validSource(source)||hero.curseSources!==undefined&&!Array.isArray(hero.curseSources))return result(false,'Invalid curse source.');
 const all=sources(hero),existing=all.find(s=>identity(s)===identity(source));
 if(existing&&existing.tier>=source.tier)return result(false,'This source is already at that tier.');
 if(!existing&&new Set(all.map(s=>s.curseId)).size>=3&&!all.some(s=>s.curseId===source.curseId))return result(false,'This hero already has three curse types.');
 const ledgerKey=encounterId===undefined?null:JSON.stringify([String(encounterId),hero.key,source.curseId]);
 if(!existing&&source.sourceType==='encounter'&&ledgerKey&&battle?.curseApplications?.[ledgerKey])return result(false,'This encounter already applied this curse.');
 if(inBattle&&natural(source)&&battle?.curseWards?.[hero.key]) {
  battle.curseWards[hero.key]=false;
  return result(false,'Witchsalt Ward blocked this curse.',{blocked:true});
 }
 if(existing)existing.tier=Math.max(existing.tier,source.tier);
 else {
  hero.curseSources??=[];
  const order=source.order??(all.reduce((n,s)=>Math.max(n,s.order??0),0)+1);
  hero.curseSources.push({curseId:source.curseId,tier:source.tier,sourceType:source.sourceType,sourceId:source.sourceId,order});
 }
 if(source.sourceType==='encounter'&&ledgerKey&&battle){battle.curseApplications??={};battle.curseApplications[ledgerKey]=true;}
 return result(true,null,{curseId:source.curseId,tier:effectiveTier(hero,source.curseId)});
}

export function reduceNaturalCurse(hero,curseId,amount=1) {
 if(!hero||!CURSE_IDS.includes(curseId)||!Number.isInteger(amount)||amount<=0)return result(false,'Invalid cleansing target.');
 const selected=sources(hero).filter(s=>s.curseId===curseId&&natural(s));
 if(!selected.length)return result(false,'This curse has no natural sources.');
 for(const source of selected)source.tier=Math.max(0,source.tier-amount);
 hero.curseSources=sources(hero).filter(s=>s.tier>0);
 return result(true,null,{curseId,tier:effectiveTier(hero,curseId)});
}

export function removeCurseSource(hero,sourceType,sourceId) {
 const all=sources(hero),remaining=all.filter(s=>s.sourceType!==sourceType||s.sourceId!==sourceId);
 if(remaining.length===all.length)return result(false,'Curse source not found.');
 hero.curseSources=remaining;return result(true);
}

function adjustGrant(hero,amount,id) {
 if(!Number.isFinite(amount)||amount<=0)return 0;
 const tier=effectiveTier(hero,id),reduction=CURSE_DEFINITIONS[id].reductions[tier]??0;
 // Integer percentages avoid floor(20 * .65) floating point surprises.
 return Math.max(1,Math.floor(amount*(100-Math.round(reduction*100))/100));
}
export const adjustHealing=(hero,amount)=>adjustGrant(hero,amount,'withered');
export const adjustDefense=(hero,amount)=>adjustGrant(hero,amount,'brittle');
/** Return HP loss only; the lifecycle owns tick receipts and mutation. */
export function bloodDebtDamage(hero) {
 if(!hero||hero.bench||!(hero.hp>0))return 0;
 return Math.min(effectiveTier(hero,'blood-debt'),Math.max(0,hero.hp-1));
}

/** Return null before any mutation if incoming curse data is invalid. */
export function migrateCurseState(state) {
 if(!state||!Array.isArray(state.heroes))return null;
 for(const hero of state.heroes) {
  if(!hero||hero.curseSources!==undefined&&!Array.isArray(hero.curseSources))return null;
  const all=sources(hero);
  if(all.some(s=>!validSource(s,{requireOrder:true}))||new Set(all.map(identity)).size!==all.length||new Set(all.map(s=>s.curseId)).size>3)return null;
 }
 state.curseVersion=2;
 state.pack??={};state.pack.remedies??={};
 state.curseProgress??={};state.curseProgress.lanternUses??={};state.curseProgress.freeCleansing??={};
 for(const hero of state.heroes){hero.curseSources??=[];hero.pendingWitchsalt??=false;hero.pendingFatigue??=false;}
 return state;
}

/** Caller checks equipment and entry receipt. Usage persists per hero and region. */
export function applyPilgrimLantern(state,hero,region) {
 if(!state||!hero||typeof hero.key!=='string'||region===undefined||region===null)return result(false,'Invalid Lantern wearer or region.');
 const uses=state.curseProgress?.lanternUses?.[region]?.[hero.key]??0;
 if(uses>=2)return result(false,'Lantern has no uses left in this region.');
 const candidates=CURSE_IDS.map(curseId=>({curseId,tier:effectiveTier(hero,curseId,{naturalOnly:true}),order:Math.min(...sources(hero).filter(s=>natural(s)&&s.curseId===curseId).map(s=>s.order))})).filter(c=>c.tier>0).sort((a,b)=>b.tier-a.tier||a.order-b.order||CURSE_IDS.indexOf(a.curseId)-CURSE_IDS.indexOf(b.curseId));
 if(!candidates.length)return result(false,'This hero has no natural curses.');
 const applied=reduceNaturalCurse(hero,candidates[0].curseId,1);
 state.curseProgress??={};state.curseProgress.lanternUses??={};state.curseProgress.lanternUses[region]??={};state.curseProgress.lanternUses[region][hero.key]=uses+1;
 return {...applied,uses:uses+1};
}
export function effectiveFatiguedStat(hero,stat,battle) {
 const value=hero?.[stat]??0;
 return battle?.curseFatigue?.[hero?.key]&&['atk','int'].includes(stat)?Math.max(1,value-2):value;
}
