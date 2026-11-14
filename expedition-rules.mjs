import {actions, enemyCurses, enemyCopper, equipment, equipmentCapacity, foes, heroes, instantItems, intent, intentPools, map, regionalBossMoves, regionOf, regions, stock, story, tokenCapacity, tokens, training} from './expedition-data.mjs';
import {canAffordCopper,copperForKill,mergeLegacyWallet} from './expedition-economy.mjs';
import {talismans,xpRewards} from './expedition-progression.mjs';
import {battleRng,pickFromStream} from './expedition-dice-rng.mjs';
import {companions,companionForHero,restoreCompanionBond,canOfferSummon,SUMMON_FACE,SUMMON_LIMIT,SUMMON_ROUNDS} from './expedition-companions.mjs';

import {CURSE_DEFINITIONS,applyCurse,effectiveTier,adjustHealing,adjustDefense,bloodDebtDamage,migrateCurseState,applyPilgrimLantern,effectiveFatiguedStat} from './expedition-curses.mjs';
import {witchShopInventory,buyRemedy,remedyCount,REMEDY_CAPACITY,REMEDY_CATALOG} from './expedition-remedies.mjs';
export {previewRemedy,useRemedy,useWitchService,witchShopInventory,buyRemedy} from './expedition-remedies.mjs';

export const living = units => units.filter(unit => unit.hp > 0);
export const active = units => living(units).filter(unit=>!unit.bench);
const partyPools=[['strike','ranged','tech-a','tech-b','relic','idle'],['rotate','rotate-left','rotate-right','strike','guard','idle'],['guard','tech-a','tech-b','relic','ranged','rotate']];
const enemyPools=[['foe-strike','foe-tech','foe-ranged','foe-boost','guard','clash'],['rotate','rotate-left','rotate-right','guard','idle','foe-tech']];
const trialEnemyPools=[
  ['idle','foe-purify','foe-target','clash','foe-boost','foe-strike'],
  ['foe-purify','foe-target','clash','foe-ranged','foe-boost','guard'],
  ['foe-purify','foe-target','foe-strike','foe-ranged','foe-boost','guard'],
];
const rotations={rotate:'Free Rotation','rotate-left':'Rotate Left','rotate-right':'Rotate Right','rotate-random':'Random Rotation'};
const firstRunRolls=[
  ['strike','rotate-left','idle','foe-strike','idle'],
  ['strike','rotate-left','idle','foe-strike','rotate-random'],
  ['strike','rotate-random','bulk-up','idle','rotate-random'],
  ['strike','rotate','idle','clash','idle'],
];
const unit = (definition, key) => ({
  key, id:definition.id, name:definition.name, hp:definition.hp, maxHp:definition.hp, atk:definition.atk,
  int:definition.int??definition.atk, ward:0, guard:false, cover:null, bleed:0, mark:0, crack:0, rooted:0, ready:{},
});

export function newRun(seed, {tutorial=false,talisman='gate',trial=0,xp=0,runId,accordTrial,accordSupport}={}) {
  if(accordTrial)trial=0;
  const starter=talismans.find(entry=>entry.id===talisman)??talismans[0];
  const run={
    version:1, seed:seed>>>0 || 1, economySeed:(seed^0x9e3779b9)||1, phase:'event', node:'threshold', visited:[], copper:0,
    combatStyle:'lead', benchKey:'tess', modifiers:{rerollAll:false}, tutorial:{enabled:tutorial, completed:[]},
    pack:{salve:0, heartwood:0, letter:0, charm:0, seed:0, equipment:[]}, bought:{}, shopOffers:{}, tokenChance:0, route:[],
    heroes:heroes.map(hero=>({...unit(hero,hero.id), level:1, equipment:[null], skills:hero.skills.slice(0,2), reach:hero.reach, relic:hero.relic})),
    talisman:starter.id, trial, runId, battle:null, report:'The wardens reach the Orchard Gate.',
  };
  if(!tutorial&&(runId||trial||xp||starter.id!=='gate')){
    run.heroes.sort((a,b)=>starter.order.indexOf(a.id)-starter.order.indexOf(b.id));
    run.benchKey=starter.order.at(-1);
    run.modifiers.rerollAll=trial>=1;
    if(trial>=2)run.heroes.slice(0,trial>=5?3:1).forEach(makeIridescent);
    if(trial>=4){addToken(run,'heal-all');addToken(run,'full-heal-all');}
    if(trial>=6)run.copper=trial>=10?30:15;
    if(trial>=7)run.pack.equipment.push('bark-shield');
    for(const reward of xpRewards)if(xp>=reward.xp)addToken(run,reward.token);
  }
  if(accordTrial){
    run.accordTrial={...accordTrial};
    if(accordTrial.supportChoice&&accordSupport==='salve')addToken(run,'salve');
    if(accordTrial.supportChoice&&accordSupport==='bark-shield')run.pack.equipment.push('bark-shield');
  }
  for(const key of Object.keys(tokens))run.pack[key]??=0;
  return migrateCurseState(run);
}

function makeIridescent(unit){
  unit.iridescent=true;
  unit.maxHp+=Math.ceil(unit.maxHp*.15);
  unit.hp=unit.maxHp;
  unit.atk++;
}
// Migrate without consuming RNG or discarding a saved roll.
export function restoreRun(saved) {
  if(!saved||saved.version!==1||!map[saved.node]||!['event','map','shop','battle','reward','complete','defeat'].includes(saved.phase)||
    !Array.isArray(saved.heroes)||saved.heroes.length!==4||!saved.pack||!Array.isArray(saved.visited)||
    saved.heroes.some(h=>!heroes.some(d=>d.id===h.id)||!Number.isFinite(h.hp)||!Array.isArray(h.skills)))return null;
  if(['battle','reward'].includes(saved.phase)&&(!saved.battle||!Array.isArray(saved.battle.dice)||!Array.isArray(saved.battle.enemies)))return null;
  saved.modifiers??={rerollAll:true};
  saved.combatStyle='lead';
  saved.benchKey??='tess';
  saved.tutorial??={enabled:false,completed:[]};
  saved.talisman??='gate';
  saved.trial??=0;
  saved.economySeed??=(saved.seed^0x9e3779b9)||1;
  saved.shopOffers??={};
  saved.tokenChance??=0;
  if(!Array.isArray(saved.pack.equipment)){
    const count=Math.min(equipmentCapacity,Math.max(0,Math.trunc(saved.pack.barkShield)||0));
    saved.pack.equipment=Array(count).fill('bark-shield');
  }
  delete saved.pack.barkShield;
  for(const hero of saved.heroes){
    hero.level??=1;
    if(!Array.isArray(hero.equipment))hero.equipment=[hero.barkShield?'bark-shield':null];
  }
  for(const key of Object.keys(tokens))saved.pack[key]??=0;
  if(saved.battle&&!saved.battle.rng)saved.battle.rng=battleRng(saved.seed);
  if(saved.battle&&!saved.battle.copperPaid)
    saved.battle.copperPaid=saved.battle.enemies.filter(enemy=>!enemy.hp).map(enemy=>enemy.key);
  if(saved.battle&&!saved.battle.defense){
    saved.battle.defense={party:0,foe:0};
    for(const member of [...saved.heroes,...saved.battle.enemies]){
      member.ward=Math.max(0,(member.ward??0)+(member.arm??0)-(member.crack?2:0));
      if(member.bleed)member.bleed=5;
    }
  }
  for(const member of [...saved.heroes,...(saved.battle?.enemies??[])])
    member.int??=heroes.find(hero=>hero.id===member.id)?.int??member.atk;
  if(saved.battle)for(const die of saved.battle.dice){
    die.fixed??=die.side==='foe'&&['sweep','siege'].includes(die.face);
    die.optional??=false;
    if(saved.battle.lead&&die.side==='foe'&&die.face==='idle')die.optional=true;
  }
  const restored=migrateCurseState(saved);
  if(restored){
    mergeLegacyWallet(restored);
    restoreCompanionBond(restored);
  }
  return restored;
}

export const tokenCount=state=>Object.keys(tokens).reduce((total,key)=>total+(state.pack[key]??0),0);
function addToken(state,key,quantity=1){
  const count=Math.max(0,Math.min(quantity,tokenCapacity-tokenCount(state)));
  state.pack[key]=(state.pack[key]??0)+count;
  return count;
}
function economyRoll(state,min,max){
  let seed=state.economySeed|0;
  seed^=seed<<13;seed^=seed>>17;seed^=seed<<5;
  state.economySeed=seed;
  return min+Math.abs(seed%(max-min+1));
}
export function shopInventory(state){
  if(currentNode(state)?.vendor==='hester')return witchShopInventory(state);
  return (stock[state.node]??[]).map(item=>{
    const price=state.shopOffers[state.node]?.[item.id]??item.price[0];
    return {...tokens[item.id],...equipment[item.id],...item,price,
      text:item.text??tokens[item.id]?.effect??equipment[item.id]?.text};
  });
}

function roll(state,faces,stream='dice') {
  return pickFromStream(state.battle.rng,stream,faces);
}

export const playerFaces = hero => ['strike','guard','shift',...hero.skills,hero.relic];
export const dieActor=(state,die)=>{
  const team=die.side==='foe'?state.battle.enemies:state.heroes;
  return die.shared?active(team)[0]:team.find(unit=>unit.key===die.key);
};
const enemyFaces=actor=>regionalBossMoves[actor.id]
  ?[...regionalBossMoves[actor.id],'guard','idle']
  :intentPools[actor.behavior];
const enemyRollPool=actor=>enemyFaces(actor).filter(face=>face!==regionalBossMoves[actor.id]?.at(-1));
export function dieFaces(state,die){
  if(die.pool)return die.pool;
  const actor=dieActor(state,die);
  return die.side==='foe'?enemyFaces(actor):playerFaces(actor);
}
export function faceKey(die,actor,face=die.face){
  if(face==='foe-strike')return foes[actor.id]?.strike??(actor.id==='sap'?'lunge':actor.id==='cradle'?'pierce':'rake');
  if(face==='foe-tech')return foes[actor.id]?.technique??(actor.id==='sap'?'pull':actor.behavior==='bulwark'?'root':'thorn');
  if(face==='tech-a')return actor.skills[0];
  if(face==='tech-b')return actor.skills[1];
  if(face==='relic')return actor.relic;
  return face;
}
export const currentNode = state => map[state.node];
export const nextRegion=state=>regions[regionOf(currentNode(state)).number];
export const available = state => state.phase==='map' ? currentNode(state).next : [];

export function configure(state, id, index, skill) {
  const definition=heroes.find(hero=>hero.id===id);
  const hero=state.heroes.find(hero=>hero.id===id);
  if(state.node!=='threshold'||state.phase!=='event'||!definition?.skills.includes(skill)||![0,1].includes(index)||hero.skills[1-index]===skill)return false;
  hero.skills[index]=skill;
  return true;
}

function finishNode(state, message) {
  state.visited.push(state.node);
  state.phase='map';
  state.report=message;
}

export function bargainPreview(state,heroKey,curseId){
  if(state.phase!=='event'||regionOf(currentNode(state)).number===1||state.node!==regionOf(currentNode(state)).entry)return null;
  const hero=state.heroes.find(h=>h.key===heroKey);
  if(!hero||!['withered','brittle','blood-debt'].includes(curseId))return null;
  const tier=regionOf(currentNode(state)).number>=4?3:regionOf(currentNode(state)).number>=3?2:1;
  return {heroKey,curseId,tier,copper:[8,12,16][tier-1],sourceId:state.node+':bargain:'+heroKey};
}
export function chooseEvent(state, choice, heroKey, curseId) {
  if(state.phase!=='event'||!story[state.node]?.choices.some(([id])=>id===choice)) return false;
  if(choice==='bargain'){
    const preview=bargainPreview(state,heroKey,curseId);
    if(!preview||state.curseBargains?.[state.node])return false;
    const hero=state.heroes.find(h=>h.key===heroKey);
    const result=applyCurse(hero,{curseId,tier:preview.tier,sourceType:'event',sourceId:preview.sourceId});
    if(!result.changed)return false;
    (state.curseBargains??={})[state.node]=true;
    state.copper+=preview.copper;
    finishNode(state,hero.name+' accepts '+curseId+' '+preview.tier+' for '+preview.copper+' Copper.');
    return true;
  }
  if(choice==='toll'&&state.copper<8)return false;
  if(choice==='revive'&&!state.heroes.some(hero=>!hero.hp))return false;
  if(choice==='ford'){
    living(state.heroes).forEach(hero=>hero.hp=Math.max(1,hero.hp-8));
    state.copper+=18;
  }
  if(choice==='toll')state.copper-=8;
  if(choice==='letter')state.pack.letter++;
  if(choice==='supplies'&&!addToken(state,'salve',2))return false;
  if(choice==='rest')living(state.heroes).forEach(hero=>{
    heal(hero,regionOf(currentNode(state)).number===1?26:Math.ceil(hero.maxHp*.5));
  });
  if(choice==='revive')state.heroes.find(hero=>!hero.hp).hp=35;
  if(choice==='remember'){
    state.pack.heartwood++;
    living(state.heroes).forEach(hero=>heal(hero,12));
  }
  if(choice==='salvage'){addToken(state,'salve');state.copper+=14;}
  const message=story[state.node].choices.find(([id])=>id===choice)[2];
  state.route.push(story[state.node].choices.find(([id])=>id===choice)[1]);
  finishNode(state,message);
  return true;
}

export function enter(state,id,{enemies,availableNodes}={}) {
  if(state.phase!=='map'||!(availableNodes??available(state)).includes(id))return false;
  state.node=id;
  const node=currentNode(state);
  state.route.push(node.name);
  if(node.enemies)startBattle(state,enemies?{...node,enemies}:node);
  else state.phase=node.type==='merchant'?'shop':'event';
  if(state.phase==='shop'&&!state.shopOffers[id]){
    state.shopOffers[id]=Object.fromEntries((stock[id]??[]).map(item=>[item.id,economyRoll(state,...item.price)]));
  }
  return true;
}

export function visitTrainer(state,choice,heroKey){
  if(state.phase!=='event'||state.node!=='trainer')return false;
  if(choice==='rest'){
    for(const hero of state.heroes)hero.hp?heal(hero,hero.maxHp):hero.hp=hero.maxHp;
    finishNode(state,'The mentor revives and heals the party.');
    return true;
  }
  if(choice==='leave'){
    finishNode(state,'The wardens leave the mentor.');
    return true;
  }
  const upgrade=training[choice];
  const hero=active(state.heroes).find(unit=>unit.key===heroKey);
  if(!upgrade||!hero)return false;
  if(choice==='slot'){
    if(hero.equipment.length>=equipmentCapacity)return false;
    hero.equipment.push(null);
  }
  if(choice==='strength')hero.atk+=upgrade.amount;
  if(choice==='power')hero.int+=upgrade.amount;
  if(choice==='health'){hero.maxHp+=upgrade.amount;hero.hp+=upgrade.amount;}
  hero.level++;
  finishNode(state,hero.name+' reaches Level '+hero.level+' · '+upgrade.label+'.');
  return true;
}

export function buy(state,id) {
  if(state.phase!=='shop')return false;
  const item=shopInventory(state).find(item=>item.id===id);
  if(!item||!canAffordCopper(state,item.price))return false;
  const {price}=item;
  if(currentNode(state)?.vendor==='hester'){
    if(!buyRemedy(state,id).ok)return false;
    state.report=item.name+' purchased for '+price+' Copper.';
    return true;
  }
  const key=state.node+':'+id;
  if(state.bought[key])return false;
  if(tokens[id]&&!addToken(state,id))return false;
  if(equipment[id]&&!stashEquipment(state,id))return false;
  state.copper-=price;
  state.bought[key]=true;
  if(!tokens[id]&&!equipment[id])state.pack[id]=(state.pack[id]??0)+1;
  state.report=item.name+' purchased for '+price+' Copper.';
  return true;
}
export function leaveShop(state) {
  if(state.phase!=='shop')return false;
  finishNode(state,'The wardens leave the trading post.');
  return true;
}
export function fieldSalve(state,key) {
  if(!['event','map','shop'].includes(state.phase)||!state.pack.salve)return false;
  const hero=state.heroes.find(hero=>hero.key===key);
  if(!hero?.hp||hero.hp>=hero.maxHp)return false;
  state.pack.salve--;
  state.report=hero.name+' recovered '+heal(hero,Math.trunc(hero.maxHp/2))+' HP.';
  return true;
}

function startBattle(state,node) {
  migrateCurseState(state);
  const trial=state.trial??0;
  for(const hero of state.heroes){
    hero.bench=state.combatStyle==='lead'&&hero.key===state.benchKey;
    Object.assign(hero,{ward:0,
      guard:false,cover:null,bleed:0,mark:0,rooted:0,firstAttackUsed:false,
      weak:0,focus:false,frozen:false,relentless:trial>=9&&hero.hp>0,ready:{},footing:false,boost:0});
  }
  const enemies=node.enemies.map((id,index)=>({...unit({...foes[id],id},'e'+index), behavior:foes[id].behavior}));
  for(const enemy of enemies)enemy.ward=foes[enemy.id].startDefense;
  for(const enemy of enemies){
    const boss=node.type==='boss';
    const tier=boss?(trial>=10?2:trial>=6?1:0):(trial>=8?2:trial>=2?1:0);
    if(tier){
      enemy.maxHp=Math.ceil(enemy.maxHp*(tier===2?1.33:1.25));
      enemy.hp=enemy.maxHp;
      enemy.atk+=tier;
    }
    if(boss&&trial>=3)enemy.guard=true;
    if(node.type==='elite'&&state.accordTrial?.eliteVariant==='fractured-ward'){
      enemy.ward=(enemy.ward??0)+4;
      enemy.guard=true;
    }
    if(boss&&trial>=11||!boss&&trial>=7&&economyRoll(state,0,99)<5)makeIridescent(enemy);
  }
  if(state.tutorial?.videoVersion===1&&node.id==='road'){
    for(const [index,enemy] of enemies.entries()){
      enemy.hp=enemy.maxHp=[24,16][index];
      enemy.atk=enemy.int=8;
    }
  }
  const defense={party:node.type==='boss'&&state.pack.charm?8:0,foe:node.id==='sanctum'&&!state.pack.letter?14:0};
  const nodeSeed=Array.from(node.id).reduce((seed,char)=>Math.imul(seed,31)+char.charCodeAt(0)|0,state.seed);
  state.battle={round:0,enemies,defense,rng:battleRng(nodeSeed),copperPaid:[],dice:[],lead:state.combatStyle==='lead',reserve:true,log:[],actions:{},bossPhase:1,cursePhase:1,curseWards:{},curseFatigue:{},curseReceipts:{},curseCasts:{}};
  state.phase='battle';
  for(const hero of state.heroes){
    if(hero.pendingWitchsalt)state.battle.curseWards[hero.key]=true;
    if(hero.pendingFatigue)state.battle.curseFatigue[hero.key]=true;
    hero.pendingWitchsalt=hero.pendingFatigue=false;
  }
  for(const hero of active(state.heroes)){
    if(hasEquipment(hero,'pilgrim-lantern'))applyPilgrimLantern(state,hero,regionOf(node).number);
    ward(hero,heroes.find(definition=>definition.id===hero.id).startDefense);
    for(const id of hero.equipment){const gear=equipment[id];if(gear?.baseId==='grave-plate')ward(hero,gear.boon);}
    hero.guard=hasEquipment(hero,'bark-shield');
    if(hasEquipment(hero,'resin-buckle'))ward(hero,6);
    if(hasEquipment(hero,'kiln-guard'))ward(hero,10);
    if(hasEquipment(hero,'rootcake'))hero.rooted=1;
  }
  nextRound(state);
}

const bossPhaseThreshold=state=>state.accordTrial?.bossVariant==='second-reckoning'?2/3:1/2;

function nextRound(state) {
  const battle=state.battle;
  for(const hero of active(state.heroes))if(hasEquipment(hero,'juniper-beads'))heal(hero,3);
  battle.round++;
  const pet=battle.companion;
  if(pet&&battle.round>pet.lastPulseRound){
    pet.lastPulseRound=battle.round;
    const changes=pulseCompanion(state,pet);
    if(changes.length)record(state,companions[pet.id].skill+' — '+changes.map(change=>change.text).join(' / '));
    if(conclude(state))return;
  }
  const receipt='blood-debt:'+battle.round;
  if(!(battle.curseReceipts??={})[receipt]){
    battle.curseReceipts[receipt]=true;
    for(const hero of active(state.heroes)){const loss=bloodDebtDamage(hero);hero.hp-=loss;}
  }
  battle.reserve=true;
  battle.rerollUsed=false;
  battle.actions={};
  if(battle.lead){nextLeadDice(state);scheduleCurses(state);return;}
  const units=living(state.heroes);
  battle.dice=units.map((hero,index)=>{
    const faces=playerFaces(hero);
    if(index===0&&canOfferSummon(state))faces[faces.length-1]=SUMMON_FACE;
    return {...makeDie(hero.key,hero.key,'party',roll(state,faces)),pool:faces};
  });
  for(const enemy of living(battle.enemies)){
    const moves=regionalBossMoves[enemy.id];
    const pool=enemyRollPool(enemy);
    const boss=enemy.behavior==='boss';
    if(boss&&enemy.hp<=enemy.maxHp*bossPhaseThreshold(state))battle.bossPhase=2;
    const face=boss&&battle.round%2===0
      ?moves?.[battle.bossPhase+1]??(battle.bossPhase===2?'siege':'sweep')
      :roll(state,pool);
    const primary=makeDie(enemy.key,enemy.key,'foe',face);
    if(moves&&battle.round%2===0)primary.fixed=true;
    battle.dice.push(primary);
    if(boss){
      const second=roll(state,pool.filter(action=>action!==face));
      battle.dice.push(makeDie(enemy.key+'b',enemy.key,'foe',second));
    }
  }
  if(state.tutorial?.enabled&&state.node==='road'&&battle.round===1){
    const teaching={rook:'guard',mara:'strike',elian:'guard',tess:'strike',e0:'rake',e1:'idle'};
    for(const die of battle.dice){
      die.face=teaching[die.id]??die.face;
      die.optional=false;
    }
  }
  scheduleCurses(state);
  record(state,'Round '+battle.round+'. Both sides have rolled.');
}

function nextLeadDice(state){
  const battle=state.battle;
  const create=(side,pools)=>pools.map((pool,index)=>({...makeDie(side+index,undefined,side,roll(state,pool)),pool,shared:true}));
  const trial=state.trial??0;
  const pools=partyPools.map(pool=>[...pool]);
  if(state.talisman==='river')pools[0]=['ranged','tech-a','tech-b','relic','strike','bulk-up'];
  if(state.talisman==='lantern')pools[2]=['guard','tech-a','tech-b','relic','bulk-up','rotate'];
  if(trial>=3)pools[0]=pools[0].map(face=>face==='idle'?'bulk-up':face);
  if(canOfferSummon(state)){
    const pool=pools.find(faces=>faces.includes('idle'))??pools[0];
    const idle=pool.indexOf('idle');
    pool[idle<0?pool.length-1:idle]=SUMMON_FACE;
  }
  battle.dice=create('party',pools);
  const boss=battle.enemies.find(unit=>unit.behavior==='boss');
  if(boss){
    if(boss.hp<=boss.maxHp*bossPhaseThreshold(state))battle.bossPhase=2;
    const moves=regionalBossMoves[boss.id];
    const pool=enemyRollPool(boss);
    const face=battle.round%2===0
      ?moves?.[battle.bossPhase+1]??(battle.bossPhase===2?'siege':'sweep')
      :roll(state,pool);
    const primary=makeDie('boss0',boss.key,'foe',face);
    if(moves&&battle.round%2===0)primary.fixed=true;
    battle.dice.push(primary,makeDie('boss1',boss.key,'foe',roll(state,pool.filter(key=>key!==face))));
  }else battle.dice.push(...create('foe',enemyPools));
  if(trial>=1){
    const pool=trialEnemyPools[trial>=9?2:trial>=4?1:0];
    battle.dice.push({...makeDie('trial-foe',undefined,'foe',roll(state,pool)),pool,shared:true});
  }
  if(state.tutorial?.videoVersion===1&&state.node==='road'&&firstRunRolls[battle.round-1]){
    const faces=firstRunRolls[battle.round-1];
    for(const [index,die] of battle.dice.entries()){
      die.face=faces[index];
      die.optional=die.side==='foe'&&die.face==='idle';
    }
  }else if(state.tutorial?.enabled&&state.node==='road'&&battle.round===1){
    const teaching={party0:'ranged',party1:'rotate-left',party2:'guard',foe0:'foe-strike',foe1:'rotate'};
    for(const die of battle.dice){die.face=teaching[die.id];die.optional=false;}
  }
  record(state,'Round '+battle.round+'. Both sides have rolled.');
}

const curseRollRules={
  ordinary:{base:[5,6,7,8,9],cap:[2,2,3,3,4]},
  elite:{base:[7,8,9,10,11],cap:[2,3,3,4,4]},
  boss:{base:[9,10,11,12,13],cap:[3,4,4,5,6]},
};
const regionalCurses=['withered','blood-debt','withered','brittle','blood-debt'];
const percentRolls=Array.from({length:100},(_,index)=>index);

// One curse roll per round, with a separate stream so existing dice rolls stay stable.
export function scheduleCurses(state){
  const battle=state.battle,node=currentNode(state),region=regionOf(node).number;
  if(state.phase!=='battle'||battle.round<2||battle.curseRollRound===battle.round) return;
  if(node.id==='road'&&(state.tutorial?.enabled||state.tutorial?.videoVersion===1)) return;

  const kind=node.type==='boss'||node.type==='elite'?node.type:'ordinary';
  const rules=curseRollRules[kind];
  const oldCasts=Object.values(battle.curseCasts??{});
  const count=battle.curseRollCount??oldCasts.reduce((total,cast)=>total+cast.count,0);
  if(count>=rules.cap[region-1]||oldCasts.some(cast=>cast.lastRound===battle.round)) return;

  const bossSignature=kind==='boss'?battle.dice.find(d=>d.side==='foe'):null;
  const die=battle.dice.findLast(d=>d.side==='foe'&&!d.spent&&!d.fixed&&!d.curse&&
    d!==bossSignature&&dieActor(state,d)?.hp>0);
  const targetCount=kind!=='ordinary'&&region>=4?2:1;
  const targets=active(state.heroes).slice(0,targetCount).map(hero=>hero.key);
  if(!die||!targets.length) return;

  battle.curseRollRound=battle.round;
  battle.rng.curse??=(battle.rng.dice^0x6d2b79f5)||1;
  if(pickFromStream(battle.rng,'curse',percentRolls)>=4*rules.base[region-1]) return;

  const caster=dieActor(state,die);
  const curseId=enemyCurses[caster.id]??regionalCurses[region-1];
  const tier=kind==='ordinary'?(region>=4?2:1):region<=2?1:kind==='boss'&&region>=4?3:2;
  Object.assign(die,{face:'curse',key:caster.key,shared:false,fixed:true,optional:false,curse:{curseId,tier,targets}});
  battle.curseRollCount=count+1;
}

function makeDie(id,key,side,face){
  return {id,key,side,face,spent:false,fixed:side==='foe'&&['sweep','siege'].includes(face),
    optional:side==='foe'&&face==='idle'};
}

export const isScriptedDie=die=>die.fixed===true;

export function rerollableDice(state) {
  if(state.phase!=='battle'||!state.modifiers?.rerollAll||state.battle.rerollUsed)return [];
  // A scripted boss attack is a telegraph, so the player can plan around it.
  return state.battle.dice.filter(die=>!die.spent&&!isScriptedDie(die)&&
    dieActor(state,die)?.hp>0);
}

export function rerollDice(state) {
  const dice=rerollableDice(state);
  if(!dice.length)return [];
  const battle=state.battle;
  for(const die of dice){
    if(die.shared){die.face=roll(state,die.pool);die.optional=die.side==='foe'&&die.face==='idle';continue;}
    if(die.side==='party'){
      const actor=state.heroes.find(unit=>unit.key===die.key);
      die.face=roll(state,die.pool??playerFaces(actor));
      continue;
    }
    const actor=battle.enemies.find(unit=>unit.key===die.key);
    const pool=enemyRollPool(actor);
    const other=battle.dice.find(entry=>entry.key===die.key&&entry.id!==die.id);
    die.face=roll(state,pool.filter(face=>face!==other?.face));
    die.fixed=actor.behavior==='boss'&&die.face==='sweep';
    die.optional=die.face==='idle';
  }
  battle.rerollUsed=true;
  record(state,'Rerolled '+dice.length+' unused dice.');
  return dice.map(die=>die.id);
}

const heal = (target,amount) => {
  const applied=Math.max(0,Math.min(adjustHealing(target,amount),target.maxHp-target.hp));
  target.hp+=applied;
  return applied;
};
const ward = (target,amount) => {
  const applied=adjustDefense(target,amount);
  target.ward+=applied;
  return applied;
};
function healingPower(actor,target,action,engraved,battle){
  if(action.maxHpFraction)return Math.trunc(target.maxHp*action.maxHpFraction);
  return Math.ceil((effectiveFatiguedStat(actor,'int',battle)+action.intBonus)*(engraved?1.25:1));
}
const swap = (team,a,b) => {
  const i=team.indexOf(a),j=team.indexOf(b);
  [team[i],team[j]]=[team[j],team[i]];
};
function record(state,message) {
  state.report=message;
  state.battle.log.unshift(message);
  state.battle.log.length=Math.min(state.battle.log.length,18);
}

export function describe(state, id, override) {
  if(state.phase!=='battle')return null;
  const b=state.battle;
  const reserve=id==='reserve';
  const die=reserve?{id,key:override?.actor,side:'party',face:override?.action}:b.dice.find(die=>die.id===id);
  if(!die||die.spent||reserve&&!b.lead&&!b.reserve)return null;
  const enemy=die.side==='foe';
  const team=enemy?b.enemies:state.heroes;
  const actor=dieActor(state,die);
  if(!actor?.hp||!enemy&&!b.lead&&(b.actions[actor.key]??0)>=2)return null;
  const other=enemy?state.heroes:b.enemies;
  const key=reserve?die.face:!enemy&&override==='brace'&&!b.lead?'brace':faceKey(die,actor);
  if(reserve&&!tokens[key]&&!['guard','shift'].includes(key))return null;
  if(reserve&&b.lead&&!tokens[key])return null;
  if(reserve&&tokens[key]&&actor!==active(team)[0])return null;
  if(enemy&&die.curse){
    const curse=die.curse;
    const name=CURSE_DEFINITIONS[curse.curseId].name+' '+['I','II','III'][curse.tier-1];
    return {die,reserve:false,enemy:true,actor,key:'curse',name,
      action:{type:'curse',...curse,text:'Applies '+name+'. Bypasses Guard and Defense. Witchsalt Ward blocks one application.'},
      targets:curse.targets.map(key=>state.heroes.find(h=>h.key===key)).filter(Boolean),reason:'',engraved:false};
  }
  if(!enemy&&key===SUMMON_FACE){
    const petId=companionForHero(actor);
    if(!petId)return null;
    const pet=companions[petId];
    return {die,reserve:false,enemy:false,actor,key,name:'Summon '+pet.name,
      action:{type:SUMMON_FACE,petId,text:pet.skill+'. '+pet.text+' Acts on arrival and at the start of the next round. '+(b.summonCount??0)+'/'+SUMMON_LIMIT+' summons used.'},
      targets:[actor],reason:canOfferSummon(state)?'':'A spirit is active or the summon limit was reached.',engraved:false};
  }
  let action=enemy?intent[key]:actions[key];
  if(rotations[key]){
    const teammates=active(team).filter(unit=>unit!==actor);
    const left=teammates[0];
    const right=teammates.at(-1);
    const directions=actor.rooted?[]:[{label:'Rotate Left',unit:left},{label:'Rotate Right',unit:right}]
      .filter(({unit})=>unit&&!unit.rooted);
    const available=key==='rotate-left'?directions.filter(option=>option.label==='Rotate Left'):
      key==='rotate-right'?directions.filter(option=>option.label==='Rotate Right'):directions;
    const targets=[...new Set(available.map(option=>option.unit))];
    return {die,reserve,enemy,actor,key,name:rotations[key],targets:targets.length?targets:[actor],
      action:{type:targets.length?'rotate':'idle',text:'Change the lead for the next action.'},
      choose:key==='rotate'&&available.length>1, directions:key==='rotate'?available:[],
      random:key==='rotate-random'&&targets.length>1};
  }
  if(!enemy&&key==='ranged')action={...actions.strike,text:'The lead attacks a chosen enemy.'};
  if(!enemy&&key==='idle')action={type:'idle',target:'self',name:'Wait'};
  if(!enemy&&key==='bulk-up')action={type:'boost',target:'self',name:'Bulk Up',text:'The lead gains 2 attack until the end of the turn.'};
  if(enemy&&die.face==='foe-strike')action={...action,rule:'front'};
  if(enemy&&key==='clash')action={type:'hit',rule:'front',name:'Clash Attack',text:'The two leads exchange attacks.'};
  if(b.lead&&key==='guard')action={...action,text:'Block the next attack.'};
  if(!action)return null;
  const engraved=!enemy&&actor.engraved===key;
  if(engraved){
    action={...action};
    if(action.type==='hit'||action.type==='pull')action.engraved=true;
    if(action.amount)action.amount=Math.ceil(action.amount*1.25);
  }
  if(action.intBonus!==undefined){
    const base=Math.max(0,effectiveFatiguedStat(actor,'int',b)+action.intBonus);
    const power=engraved?(action.type==='heal'?Math.ceil(base*1.25):Math.trunc(base*1.25)):base;
    action={...action,text:(action.text??'')+' Power: '+power+' (INT).'};
  }
  const name=['strike','ranged'].includes(key)?heroes.find(hero=>hero.id===actor.id).strike:action.name;
  let targets=[];
  let reason='';
  if(enemy){
    const rivals=active(other);
    if(action.rule==='party')targets=rivals;
    else if(action.rule==='edges')targets=rivals.length>1?[rivals[0],rivals.at(-1)]:rivals;
    else if(action.rule==='wounded')targets=[rivals.reduce((a,b)=>!a||b.hp<a.hp?b:a,null)].filter(Boolean);
    else if(action.rule==='front')targets=rivals.slice(0,1);
    else if(action.rule==='rear')targets=rivals.slice(-1);
    else if(action.rule==='friend')targets=[living(team).reduce((a,b)=>!a||b.ward<a.ward?b:a,null)].filter(Boolean);
    else targets=[actor];
  }else{
    const friends=active(team);
    const position=team.indexOf(actor);
    if(action.target==='self')targets=[actor];
    if(action.target==='ally')targets=friends;
    if(action.target==='wounded')targets=friends.filter(unit=>unit.hp<unit.maxHp);
    if(action.target==='afflicted')targets=friends.filter(unit=>unit.bleed||unit.rooted);
    if(action.target==='other')targets=friends.filter(unit=>unit!==actor);
    if(action.target==='adjacent')targets=friends.filter(unit=>Math.abs(team.indexOf(unit)-position)===1);
    if(action.target==='enemy')targets=active(other).slice(0,b.lead&&key==='strike'?1:['ranged','final-delivery'].includes(key)?4:actor.reach);
    if(action.type==='shift')targets=actor.rooted?[]:targets.filter(unit=>!unit.rooted);
    if((actor.ready[key]??0)>b.round)reason='Ready in round '+actor.ready[key]+'.';
    if(reserve&&tokens[key]&&!state.pack[key])reason='No '+tokens[key].name+' in the satchel.';
    if(key==='purify-token'&&!['bleed','rooted','weak','mark','frozen'].some(status=>actor[status]))reason='The lead has no debuffs.';
    if(!targets.length&&!reason)reason='No eligible target.';
  }
  return {die,reserve,enemy,actor,key,action,name,targets,reason,engraved};
}

// APK ComputeDamage separates attacks from direct damage and consumes squad defense first.
function applyDamage(state,target,amount,{attack=false,ignoreDefense=false}={}){
  const side=state.heroes.includes(target)?'party':'foe';
  const defense=state.battle.defense;
  const blocked=attack&&target.guard;
  if(blocked)target.guard=false;
  const team=side==='party'?state.heroes:state.battle.enemies;
  const evaded=attack&&!blocked&&target.sneaky&&active(team).some(unit=>unit!==target);
  let remaining=blocked||evaded?0:Math.max(0,Math.trunc(amount));
  const squadAbsorbed=attack&&!ignoreDefense?Math.min(defense[side],remaining):0;
  defense[side]-=squadAbsorbed;
  remaining-=squadAbsorbed;
  const personalAbsorbed=attack&&!ignoreDefense?Math.min(target.ward,remaining):0;
  target.ward-=personalAbsorbed;
  remaining-=personalAbsorbed;
  const pet=state.battle.companion;
  let spiritAbsorbed=0;
  if(attack&&!ignoreDefense&&pet?.owner===target.key&&side==='party'){
    const armor=Math.min(pet.defense,remaining);
    pet.defense-=armor;
    const vitality=Math.min(pet.hp,remaining-armor);
    pet.hp-=vitality;
    spiritAbsorbed=armor+vitality;
    remaining-=spiritAbsorbed;
  }
  const survived=attack&&target.relentless&&remaining>=target.hp;
  if(survived)target.relentless=false;
  const loss=Math.min(target.hp-(survived?1:0),remaining);
  target.hp-=loss;
  if(target.behavior==='boss')target.cursePhase=Math.max(target.cursePhase??1,target.hp<=target.maxHp/3?3:target.hp<=target.maxHp*2/3?2:1);
  return {loss,blocked,evaded:Boolean(evaded),survived:Boolean(survived),absorbed:squadAbsorbed+personalAbsorbed+spiritAbsorbed,squadAbsorbed,personalAbsorbed,spiritAbsorbed};
}

function attackDamage(base,source,target,action){
  let scale=1;
  if(source.weak)scale-=.25;
  if(source.focus)scale++;
  if(target.frozen)scale++;
  if(action.critical)scale++;
  if(action.elemental)scale++;
  return Math.trunc(base*scale)+(target.mark?4:0);
}

function rotationBleed(state,team,changes){
  for(const member of active(team)){
    if(!member.bleed)continue;
    const result=applyDamage(state,member,member.bleed);
    changes.push({target:member.key,text:member.name+' −'+result.loss+' HP from Bleed',...result});
  }
}

function applyLeadEquipment(state,priorLead,changes){
  const lead=active(state.heroes)[0];
  if(!lead||lead===priorLead||!hasEquipment(lead,'ferryman-cord'))return;
  changes.push({target:lead.key,text:lead.name+' +'+ward(lead,3)+' Defense · Ferryman’s Cord'});
}

function directHit(state, source, target, action, multi, extra=0) {
  const team=state.heroes.includes(target)?state.heroes:state.battle.enemies;
  let covered;
  if(!multi&&target.cover){
    const protector=team.find(unit=>unit.key===target.cover&&unit.hp);
    target.cover=null;
    if(protector){covered=target.name;target=protector;}
  }
  const strength=effectiveFatiguedStat(source,'atk',state.battle)+(source.boost??0);
  const hollow=source.equipment?.map(id=>equipment[id]).find(g=>g?.baseId==='hollow-band');
  if((hollow||hasEquipment(source,'hollow-band'))&&(!source.firstAttackUsed||action.hollowVolley))extra+=hollow?.boon??4;
  source.firstAttackUsed=true;
  for(const id of source.equipment??[])if(equipment[id]?.baseId==='thorn-covenant')extra+=equipment[id].boon;
  const base=Math.max(0,action.intBonus===undefined?strength:effectiveFatiguedStat(source,'int',state.battle)+action.intBonus);
  const damage=attackDamage(Math.trunc((base+extra)*(action.engraved?1.25:1)),source,target,action);
  const result=applyDamage(state,target,damage,{attack:true,ignoreDefense:action.pierce});
  if(source.focus)source.focus=false;
  const {loss,blocked,absorbed}=result;
  if(target.hp>0&&!blocked&&!result.evaded){
    if(action.bleed)target.bleed+=strength;
    if(action.root)target.rooted=2;
    if(action.crack)target.ward=Math.max(0,target.ward-2);
  }
  return {target:target.key,text:target.name+(blocked?' blocked the attack':result.evaded?' evaded the attack':' −'+loss+' HP')+(absorbed?' · '+absorbed+' Defense absorbed':'')+
    (covered?' · covering '+covered:''), ...result, covered};
}

function pulseCompanion(state,pet){
  const spirit=companions[pet.id];
  const allies=active(state.heroes);
  const owner=allies.find(hero=>hero.key===pet.owner);
  if(!owner)return [];
  if(spirit.effect==='ward'){
    return [{target:owner.key,text:owner.name+' +'+ward(owner,spirit.def*2)+' Defense'}];
  }
  if(spirit.effect==='heal'||spirit.effect==='cleanse'){
    const target=spirit.effect==='heal'?[...allies].sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0]:owner;
    if(spirit.effect==='cleanse')target.bleed=target.rooted=0;
    return [{target:target.key,text:target.name+' +'+heal(target,spirit.int)+' HP'+(spirit.effect==='cleanse'?' · Bleed and Rooted cleared':'')}];
  }
  const target=active(state.battle.enemies)[0];
  if(!target)return [];
  const result=applyDamage(state,target,spirit.str||spirit.int,{attack:true});
  if(target.hp&&!result.blocked&&!result.evaded){
    if(spirit.effect==='mark')target.mark=Math.max(target.mark??0,2);
    if(spirit.effect==='scorch')target.bleed=(target.bleed??0)+3;
  }
  return [{target:target.key,text:target.name+(result.blocked?' blocked '+spirit.skill:result.evaded?' evaded '+spirit.skill:' −'+result.loss+' HP'),...result}];
}

export function resolve(state,id,targetKey,override) {
  const plan=describe(state,id,override);
  if(!plan||plan.reason)return null;
  const {action,actor,enemy,key,die,reserve,targets,name,engraved}=plan;
  const b=state.battle;
  const priorLead=active(state.heroes)[0];
  const chosen=key===SUMMON_FACE?targets:plan.random?[roll(state,targets,'effects')]:enemy&&!plan.choose?targets:targets.filter(unit=>unit.key===targetKey);
  if(!chosen.length&&action.type!=='curse')return null;
  const target=chosen[0];
  if(reserve)b.reserve=false;
  else {die.spent=true;die.resolvedKey=key;die.resolvedActor=actor.key;}
  if(!enemy)b.actions[actor.key]=(b.actions[actor.key]??0)+1;
  if(action.cd)actor.ready[key]=b.round+action.cd+1;
  const changes=[];
  if(key===SUMMON_FACE){
    const id=action.petId,spirit=companions[id];
    b.summonCount=(b.summonCount??0)+1;
    b.companion={id,owner:actor.key,hp:spirit.hp,defense:spirit.def,expiresAfter:b.round+SUMMON_ROUNDS-1,lastPulseRound:b.round};
    changes.push(...pulseCompanion(state,b.companion));
  }
  if(action.type==='curse')for(const hero of chosen){
    if(!hero.hp||hero.bench)continue;
    const result=applyCurse(hero,{curseId:action.curseId,tier:action.tier,sourceType:'encounter',sourceId:state.node+':'+actor.key+':'+hero.key+':'+action.curseId},{battle:b,inBattle:true,encounterId:state.node});
    changes.push({target:hero.key,text:hero.name+(result.changed?' receives '+name:result.blocked?' blocked the curse':' resists the repeated curse'),...result});
  }
  if(reserve&&tokens[key])state.pack[key]--;
  if(action.type==='hit'||action.type==='pull'){
    let extra=0;
    if(action.spendWard){
      const amount=Math.min(actor.ward,20);
      actor.ward-=amount;
      extra+=amount*.5;
    }
    const hitAction={...action,hollowVolley:!actor.firstAttackUsed};
    for(const unit of chosen)changes.push(directHit(state,actor,unit,hitAction,chosen.length>1,extra));
    actor.firstAttackUsed=true;
    if(key==='clash'&&target.hp>0)changes.push(directHit(state,target,actor,actions.strike,false));
    const connected=!changes[0].blocked&&!changes[0].evaded&&!changes[0].covered;
    if(action.pull&&connected&&!target.rooted&&target.hp&&target.behavior!=='boss'){
      const position=b.enemies.indexOf(target);
      if(position>0)swap(b.enemies,target,b.enemies[position-1]);
    }
    if(action.type==='pull'&&connected&&!actor.rooted&&!target.rooted&&target.hp){
      const front=active(state.heroes)[0];
      if(front!==target&&!front.rooted)swap(state.heroes,target,front);
    }
  }
  if(action.type==='guard'){
    actor.guard=true;
    changes.push({target:actor.key,text:actor.name+' is guarding'});
  }
  if(action.type==='boost'){
    if(action.permanent)actor.atk++;
    else actor.boost=(actor.boost??0)+2;
    changes.push({target:actor.key,text:actor.name+(action.permanent?' +1 STR': ' +2 STR')});
  }
  if(action.type==='ward')changes.push({target:target.key,text:target.name+' +'+ward(target,action.amount)+' Defense'});
  if(action.type==='heal'){
    for(const unit of action.healTeam?active(state.heroes):[target])
      changes.push({target:unit.key,text:unit.name+' +'+heal(unit,healingPower(actor,unit,action,engraved,b))+' HP'});
  }
  if(action.type==='mark')for(const unit of chosen){unit.mark=2;changes.push({target:unit.key,text:unit.name+' marked'});}
  if(action.type==='cleanse'){
    target.bleed=target.rooted=0;
    if(['purify-token','foe-purify'].includes(key)){target.weak=target.mark=0;target.frozen=false;}
    changes.push({target:target.key,text:target.name+' cleansed'});
  }
  if(action.type==='cover'){target.cover=actor.key;changes.push({target:target.key,text:actor.name+' covers '+target.name});}
  if(action.type==='shift'){
    swap(state.heroes,actor,target);
    if(action.amount)for(const unit of [actor,target])ward(unit,action.amount);
    if(actor.id==='mara'&&key==='shift'&&!actor.footing){actor.footing=true;ward(actor,5);}
    changes.push({target:target.key,text:actor.name+' swaps with '+target.name});
    rotationBleed(state,state.heroes,changes);
    applyLeadEquipment(state,priorLead,changes);
  }
  if(action.type==='rotate'){
    const team=enemy?b.enemies:state.heroes;
    const order=active(team), positions=order.map(unit=>team.indexOf(unit));
    const pivot=order.indexOf(target);
    positions.forEach((position,index)=>{team[position]=order[(index+pivot)%order.length];});
    changes.push({target:target.key,text:target.name+' takes the lead'});
    rotationBleed(state,team,changes);
    if(!enemy)applyLeadEquipment(state,priorLead,changes);
  }
  cancelFallen(state);
  record(state,actor.name+' · '+name+(changes.length?' — '+changes.map(change=>change.text).join(' / '):' — No effect.'));
  conclude(state);
  return {actor:actor.key, side:die.side, targets:changes.map(change=>change.target), name, key, type:action.type,
    art:action.art??(!enemy&&action.type==='guard'?'brace':undefined), changes};
}

function cancelFallen(state) {
  for(const die of state.battle.dice)if(!dieActor(state,die)?.hp&&!die.spent)die.cancelled=die.spent=true;
}
export const pendingEnemyDice=state=>state.phase!=='battle'?[]:state.battle.dice.filter(die=>
  die.side==='foe'&&!die.spent&&!die.optional&&dieActor(state,die)?.hp>0);
export const canEndRound=state=>state.phase==='battle'&&pendingEnemyDice(state).length===0;
export function endRound(state) {
  if(!canEndRound(state))return false;
  for(const unit of active([...state.heroes,...state.battle.enemies])){
    unit.boost=0;
    for(const key of ['mark','rooted','weak'])if(unit[key])unit[key]--;
    unit.cover=null;
  }
  if(state.battle.companion?.expiresAfter<=state.battle.round)state.battle.companion=null;
  cancelFallen(state);
  if(!conclude(state))nextRound(state);
  return true;
}

function conclude(state) {
  const battle=state.battle;
  const tutorialRoad=state.node==='road'&&state.tutorial?.videoVersion===1;
  const node=currentNode(state),region=regionOf(node);
  for(const enemy of battle.enemies){
    if(enemy.hp||battle.copperPaid.includes(enemy.key))continue;
    battle.copperPaid.push(enemy.key);
    if(!tutorialRoad){
      const base=enemyCopper[enemy.id]??(enemy.behavior==='boss'?8+region.number:4+region.number);
      const copper=copperForKill(base,node.type,region.number);
      state.copper+=copper;
      battle.copperEarned=(battle.copperEarned??0)+copper;
      battle.log.unshift(enemy.name+' defeated · +'+copper+' Copper.');
    }
  }
  if(!active(state.heroes).length){
    state.phase='defeat';
    state.report='The last warden falls in '+regionOf(currentNode(state)).name+'.';
  }else if(!living(state.battle.enemies).length){
    state.phase='reward';
    if(currentNode(state).id===regions.at(-1).boss) breakFinalCurse(state);
    if(!tutorialRoad)rewardOffer(state);
    state.report=currentNode(state).type==='boss'
      ?nextRegion(state)?'The Waymark opens the road to '+nextRegion(state).name+'.':'The final Waymark breaks every curse on the wardens.'
      :'The trail is clear.';
  }else return false;
  battle.curseWards={};battle.curseFatigue={};battle.companion=null;
  for(const hero of state.heroes.filter(unit=>!unit.bench)){
    if(!hero.hp&&hasEquipment(hero,'kiln-guard')){
      hero.equipment[hero.equipment.indexOf('kiln-guard')]=null;
      battle.log.unshift(hero.name+'’s Kiln Guard broke.');
    }
    if(hero.hp&&state.phase==='reward'&&hasEquipment(hero,'rootcake')){
      hero.equipment[hero.equipment.indexOf('rootcake')]=null;
      hero.maxHp+=2;
      hero.hp+=2;
      battle.log.unshift(hero.name+' ate the Rootcake and gained 2 Max HP.');
    }
  }
  return true;
}

function breakFinalCurse(state){
  for(const hero of state.heroes) hero.curseSources=[];
}

export function rewardOffer(state){
  if(state.phase!=='reward'||hasTutorialLoot(state))return null;
  if(state.battle.rewardOffer)return state.battle.rewardOffer;
  const ordinary=['battle','coin'].includes(currentNode(state).type);
  const copper=ordinary&&economyRoll(state,0,99)<10?economyRoll(state,3,15):0;
  const tokenHit=ordinary&&economyRoll(state,0,99)<state.tokenChance;
  if(ordinary)state.tokenChance=Math.max(0,Math.min(100,state.tokenChance+(tokenHit?-55:12)));
  const tokenPool=['guard-token','purify-token'];
  const token=tokenHit?tokenPool[economyRoll(state,0,tokenPool.length-1)]:null;
  const type=currentNode(state).type;
  const region=regionOf(currentNode(state)).number;
  const gear=Object.keys(equipment).filter(id=>id!=='hollow-band'&&(equipment[id].minRegion??1)<=region);
  const equipmentCount=type==='boss'?3:type==='elite'||ordinary&&economyRoll(state,0,99)<5?1:0;
  const gearOffers=[];
  for(let i=0;i<equipmentCount;i++)gearOffers.push(...gear.splice(economyRoll(state,0,gear.length-1),1));
  const instantKeys=Object.keys(instantItems);
  const instant=ordinary&&economyRoll(state,0,99)<5?instantKeys[economyRoll(state,0,instantKeys.length-1)]:null;
  const remedy=state.node!=='road'&&economyRoll(state,0,99)<15?'ashwater-phial':null;
  return state.battle.rewardOffer={copper,token,gear:gearOffers,instant,remedy};
}

export const canEngrave = (hero,key) => Boolean(hero?.hp&&!hero.engraved&&hero.skills.includes(key)&&
  (actions[key]?.intBonus!==undefined||actions[key]?.amount));
export const hasTutorialLoot=state=>state.phase==='reward'&&state.node==='road'&&state.tutorial?.videoVersion===1;
export const hasEquipment=(hero,key)=>hero.equipment?.includes(key)??false;
const canManageGear=state=>['map','reward','event','shop'].includes(state.phase);
function stashEquipment(state,key){
  if(!Object.hasOwn(equipment,key)||state.pack.equipment.length>=equipmentCapacity)return false;
  state.pack.equipment.push(key);
  return true;
}
export function moveEquipment(state,heroKey,slot,index=null,options={}){
  if(!canManageGear(state))return false;
  const hero=state.heroes.find(unit=>unit.key===heroKey);
  if(!hero||!Number.isInteger(slot)||slot<0||slot>=hero.equipment.length)return false;
  const equipped=hero.equipment[slot];
  if(equipment[equipped]?.tag==='Cursed')return false;
  if(index===null){
    if(!equipped||!stashEquipment(state,equipped))return false;
    hero.equipment[slot]=null;
  }else{
    const next=Number.isInteger(index)&&state.pack.equipment[index];
    if(!next||hasEquipment(hero,next))return false;
    const definition=equipment[next];
    if(hero.equipment.some(id=>id&&(equipment[id]?.baseId??id)===(definition.baseId??next)))return false;
    if(definition.curse){
      if(options.confirmed!==true)return false;
      const result=applyCurse(hero,{curseId:definition.curse,tier:definition.tier,sourceType:'gear',sourceId:hero.key+':slot:'+slot});
      if(!result.changed)return false;
    }
    if(equipped)state.pack.equipment[index]=equipped;
    else state.pack.equipment.splice(index,1);
    hero.equipment[slot]=next;
  }
  hero.barkShield=hasEquipment(hero,'bark-shield');
  return true;
}
export function discardEquipment(state,index){
  if(!canManageGear(state)||!Number.isInteger(index)||!state.pack.equipment[index])return false;
  state.pack.equipment.splice(index,1);
  return true;
}
export function equipBarkShield(state,heroKey){
  const hero=active(state.heroes).find(unit=>unit.key===heroKey);
  if(!hero)return false;
  return moveEquipment(state,heroKey,hero.equipment.indexOf(null),state.pack.equipment.indexOf('bark-shield'));
}

export function tutorialLoot(state,item){
  if(!hasTutorialLoot(state))return false;
  const loot=state.battle.tutorialLoot??={};
  if(item==='shield'){
    if(loot.shield||!stashEquipment(state,'bark-shield'))return false;
    loot.shield=true;
    return true;
  }
  if(item==='salve'){
    if(loot.salve||!addToken(state,'salve'))return false;
    loot.salve=true;return true;
  }
  if(item!=='leave')return false;
  finishNode(state,'The trail is clear. Choose the next stop.');state.battle=null;
  return true;
}
export function claim(state,choice,heroKey,skill) {
  if(state.phase!=='reward'||hasTutorialLoot(state))return false;
  const type=currentNode(state).type;
  const offer=rewardOffer(state);
  if(choice==='remedy'){
    if(!offer.remedy||remedyCount(state)>=REMEDY_CAPACITY)return false;
    state.pack.remedies[offer.remedy]=(state.pack.remedies[offer.remedy]??0)+1;
    offer.remedy=null;
    return true;
  }
  if(choice==='equipment'){
    if(!offer.gear?.includes(heroKey)||!stashEquipment(state,heroKey))return false;
    offer.gear=[];
    state.report=equipment[heroKey].name+' collected.';
    return true;
  }
  if(choice==='instant'){
    const hero=state.heroes.find(unit=>unit.key===heroKey);
    if(!hero||!offer.instant||!hero.hp&&offer.instant!=='umami-broth')return false;
    if(offer.instant==='spiceberry')hero.atk++;
    if(offer.instant==='bitterberry'){hero.maxHp+=2;hero.hp+=2;}
    if(offer.instant==='umami-broth')hero.hp?heal(hero,10):hero.hp=1;
    state.report=hero.name+' uses '+instantItems[offer.instant].name+'.';
    offer.instant=null;
    return true;
  }
  if(choice==='token'){
    if(!offer.token||!addToken(state,offer.token))return false;
    state.report=tokens[offer.token].name+' collected.';
    offer.token=null;
    return true;
  }
  if(choice==='copper'){
    if(!offer.copper)return false;
    state.copper+=offer.copper;
    state.report=offer.copper+' Copper collected.';
    offer.copper=0;
    return true;
  }
  if(!['leave','engrave'].includes(choice))return false;
  if(choice==='engrave'){
    const hero=state.heroes.find(unit=>unit.key===heroKey);
    if(type!=='elite'||state.battle.engravingClaimed||!canEngrave(hero,skill))return false;
    hero.engraved=skill;
    state.report=actions[skill].name+' engraved.';
    state.battle.engravingClaimed=true;
    return true;
  }
  if(type==='elite')state.pack.heartwood++;
  if(type==='boss'){
    const next=nextRegion(state);
    if(next){
      for(const hero of state.heroes){
        hero.level++;
        hero.atk+=3;
        hero.int+=2;
        hero.maxHp+=8;
      }
    }
    const trial=state.trial??0;
    for(const hero of state.heroes.filter(hero=>!hero.bench)){
      const recovery=state.accordTrial?state.accordTrial.recoveryPercent/100
        :trial>=10?(hero.hp?0:.01):trial>=5?.5:1;
      if(!hero.hp)hero.hp=Math.ceil(hero.maxHp*recovery);else heal(hero,Math.ceil(hero.maxHp*recovery));
    }
    if(state.node==='sanctum')state.pack.seed++;
    state.visited.push(state.node);
    if(next){
      state.node=next.entry;
      // Regional entry is an optional bargain event; it must remain reachable after a boss.
      state.route.push(currentNode(state).name);
      state.phase='event';
      state.report='The wardens reach '+next.name+' · Waymark blessing: +3 STR, +2 INT, +8 Max HP.';
    }else{
      breakFinalCurse(state);
      state.phase='complete';
      state.report='With the five Waymarks restored, the wardens break the curse and return the names of the missing.';
    }
  }else finishNode(state,'Loot secured. Choose the next stop.');
  state.battle=null;
  return true;
}

