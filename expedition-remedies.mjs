import {equipment, equipmentCapacity, map, regionOf} from './expedition-data.mjs';
import {canAffordCopper} from './expedition-economy.mjs';
import {reduceNaturalCurse, removeCurseSource} from './expedition-curses.mjs';

export const REMEDY_CAPACITY=6;
export const REMEDY_CATALOG=Object.freeze({
  'ashwater-phial':Object.freeze({id:'ashwater-phial',name:'Ashwater Phial',price:6,stock:2,minRegion:1,reduction:1,text:'Lower every natural source of one curse on one hero by one tier. Equipment curses remain.'}),
  'distilled-ashwater':Object.freeze({id:'distilled-ashwater',name:'Distilled Ashwater',price:10,stock:1,minRegion:3,reduction:2,text:'Lower every natural source of one curse on one hero by two tiers. Equipment curses remain.'}),
  'severance-seal':Object.freeze({id:'severance-seal',name:'Severance Seal',price:12,stock:1,minRegion:1,text:'Destroy one equipped cursed item and remove its curse source. The equipment slot becomes empty.'}),
  'witchsalt-ward':Object.freeze({id:'witchsalt-ward',name:'Witchsalt Ward',price:5,stock:1,minRegion:1,text:'Block the next natural curse application in the next battle. Expires when that battle ends. Does not stack.'}),
});
export const WITCH_SERVICES=Object.freeze({
  unbinding:Object.freeze({id:'unbinding',name:'Unbinding',price:10,text:'Destroy one equipped cursed item and remove its curse source.'}),
  'humble-cleansing':Object.freeze({id:'humble-cleansing',name:'Humble Cleansing',price:0,text:'Once per region: lower every natural source of one curse on one hero by one tier. That hero starts the next battle Fatigued: -2 STR and INT, minimum 1.'}),
});
const fieldPhases=new Set(['map','event','shop','reward']);
const fail=reason=>({ok:false,reason,changes:null});
const success=changes=>({ok:true,reason:null,changes});
const region=state=>regionOf(map[state.node]).number;
const isWitch=state=>state?.phase==='shop'&&map[state.node]?.vendor==='hester';
const cancelled=options=>options?.confirmed===false||options?.cancelled===true;
export const remedyCount=state=>Object.values(state?.pack?.remedies??{}).reduce((sum,n)=>sum+(Number.isSafeInteger(n)&&n>0?n:0),0);

// Reading a preview or opening a shop never writes a receipt or initializes stock.
export function witchShopInventory(state){
  if(!isWitch(state))return [];
  const lantern={id:'pilgrim-lantern',...equipment['pilgrim-lantern'],price:18,stock:1,minRegion:2};
  return [...Object.values(REMEDY_CATALOG),lantern].filter(item=>region(state)>=item.minRegion).map(item=>{
    const remaining=state.shopRemedyStock?.[state.node]?.[item.id]??item.stock;
    let reason=null;
    if(remaining<=0)reason='Sold out.';
    else if(item.id==='pilgrim-lantern'&&(state.pack?.equipment?.length??0)>=equipmentCapacity)reason='Equipment inventory is full.';
    else if(item.id!=='pilgrim-lantern'&&remedyCount(state)>=REMEDY_CAPACITY)reason='Remedies inventory is full (6 units).';
    const stockReason=reason;
    if(!reason&&!canAffordCopper(state,item.price))reason='Not enough Copper.';
    return {...item,stock:remaining,remaining,available:!reason,reason,stockReason};
  });
}

export function grantRemedy(state,itemId,quantity=1){
  if(!fieldPhases.has(state?.phase))return fail('Remedies can only be received outside battle.');
  if(!REMEDY_CATALOG[itemId])return fail('Unknown remedy.');
  if(!Number.isSafeInteger(quantity)||quantity<1)return fail('Invalid quantity.');
  if(remedyCount(state)+quantity>REMEDY_CAPACITY)return fail('Remedies inventory is full (6 units).');
  state.pack??={};state.pack.remedies??={};
  state.pack.remedies[itemId]=(state.pack.remedies[itemId]??0)+quantity;
  return success({itemId,quantity});
}

export function buyRemedy(state,itemId,options={}){
  if(cancelled(options))return fail('Cancelled.');
  if(!isWitch(state))return fail('Visit Wren’s Hex Remedies to buy this item.');
  const item=witchShopInventory(state).find(item=>item.id===itemId);
  if(!item)return fail('This item is not available in this region.');
  if(item.stockReason)return fail(item.stockReason);
  if(!canAffordCopper(state,item.price))return fail('Not enough Copper.');
  const {price}=item;
  // All validation precedes any writes; remedies and equipment use separate bags.
  state.pack??={};
  if(itemId==='pilgrim-lantern'){state.pack.equipment??=[];state.pack.equipment.push(itemId);}
  else {state.pack.remedies??={};state.pack.remedies[itemId]=(state.pack.remedies[itemId]??0)+1;}
  state.copper-=price;
  state.shopRemedyStock??={};state.shopRemedyStock[state.node]??={};
  state.shopRemedyStock[state.node][itemId]=item.stock-1;
  return success({itemId,quantity:1,copper:-price,stock:item.stock-1});
}

function targetPreview(state,itemId,heroKey,options){
  if(!fieldPhases.has(state?.phase))return fail('Remedies can only be used outside battle.');
  if(cancelled(options))return fail('Cancelled.');
  const hero=state.heroes?.find(hero=>hero.key===heroKey);
  if(!hero)return fail('Choose a valid hero.');
  const before=structuredClone(hero),after=structuredClone(hero);
  const reduction=REMEDY_CATALOG[itemId]?.reduction??(itemId==='humble-cleansing'?1:0);
  if(reduction){
    const result=reduceNaturalCurse(after,options.curseId,reduction);
    if(!result.changed)return fail('Choose a curse with at least one natural source.');
  }else if(itemId==='witchsalt-ward'){
    if(hero.pendingWitchsalt)return fail('This hero already has a pending Witchsalt Ward.');
    after.pendingWitchsalt=true;
  }else if(itemId==='severance-seal'||itemId==='unbinding'){
    const slot=options.slot;
    if(!Number.isSafeInteger(slot)||slot<0||slot>=(hero.equipment?.length??0))return fail('Choose a valid equipment slot.');
    const gearId=hero.equipment[slot],gear=equipment[gearId];
    if(!gear||(!gear.curse&&gear.tag!=='Cursed'))return fail('Choose an equipped cursed item.');
    const sourceId=hero.key+':slot:'+slot;
    // Legacy locked equipment has no v2 source. Destroying it is still valid.
    removeCurseSource(after,'gear',sourceId);
    after.equipment[slot]=null;
  }else return fail('Unknown remedy or service.');
  return success({heroKey,before,after,itemId,curseId:options.curseId??null,slot:options.slot??null});
}
export function previewRemedy(state,itemId,heroKey,options={}){
  if(!REMEDY_CATALOG[itemId])return fail('Unknown remedy.');
  if(!(state.pack?.remedies?.[itemId]>0))return fail('You do not have this remedy.');
  return targetPreview(state,itemId,heroKey,options);
}
function commitHero(state,changes){
  // Keep the original hero object for existing scene references.
  Object.assign(state.heroes.find(hero=>hero.key===changes.heroKey),changes.after);
}
export function useRemedy(state,itemId,heroKey,options={}){
  const result=previewRemedy(state,itemId,heroKey,options);
  if(!result.ok)return result;
  commitHero(state,result.changes);
  state.pack.remedies[itemId]--;
  return result;
}
export function previewWitchService(state,serviceId,heroKey,options={}){
  if(!isWitch(state))return fail('Visit Wren’s Hex Remedies for this service.');
  if(cancelled(options))return fail('Cancelled.');
  const service=WITCH_SERVICES[serviceId];
  if(!service)return fail('Unknown service.');
  if(!Number.isFinite(state.copper)||state.copper<service.price)return fail('Not enough Copper.');
  const hero=state.heroes?.find(hero=>hero.key===heroKey);
  if(serviceId==='humble-cleansing'){
    if(state.curseProgress?.freeCleansing?.[region(state)])return fail('Humble Cleansing has been used in this region.');
    if(hero?.pendingFatigue)return fail('This hero already has pending Fatigue.');
  }
  const result=targetPreview(state,serviceId,heroKey,options);
  if(!result.ok)return result;
  if(serviceId==='humble-cleansing')result.changes.after.pendingFatigue=true;
  result.changes.copper=-service.price;
  result.changes.region=region(state);
  return result;
}
export function useWitchService(state,serviceId,heroKey,options={}){
  const result=previewWitchService(state,serviceId,heroKey,options);
  if(!result.ok)return result;
  commitHero(state,result.changes);
  state.copper+=result.changes.copper;
  if(serviceId==='humble-cleansing'){
    state.curseProgress??={};state.curseProgress.freeCleansing??={};
    state.curseProgress.freeCleansing[result.changes.region]=true;
  }
  return result;
}
