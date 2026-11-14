import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCurse,effectiveTier,reduceNaturalCurse,removeCurseSource,adjustHealing,adjustDefense,bloodDebtDamage,migrateCurseState,applyPilgrimLantern,effectiveFatiguedStat} from './expedition-curses.mjs';
const hero=()=>({key:'mara',hp:20,atk:4,int:3,curseSources:[]});
const source=(curseId='withered',tier=1,sourceType='encounter',sourceId='a',order=1)=>({curseId,tier,sourceType,sourceId,order});
test('independent sources preserve maximum tier and natural cleansing reduces every natural source',()=>{
 const h=hero(); applyCurse(h,source('withered',3)); applyCurse(h,source('withered',2,'gear','slot0',2)); applyCurse(h,source('withered',2,'event','event',3));
 assert.equal(reduceNaturalCurse(h,'withered',2).changed,true); assert.equal(effectiveTier(h,'withered'),2); assert.equal(effectiveTier(h,'withered',{naturalOnly:true}),1);
 removeCurseSource(h,'gear','slot0'); assert.equal(effectiveTier(h,'withered'),1); assert.equal(h.curseSources.length,1);
});
test('same source cannot stack and invalid applications never mutate',()=>{
 const h=hero(); applyCurse(h,source()); assert.equal(applyCurse(h,source()).changed,false); applyCurse(h,source('withered',3)); assert.equal(h.curseSources.length,1);
 const before=JSON.stringify(h); for(const bad of [source('unknown'),source('brittle',4),source('brittle',1.5),source('brittle',1,'invalid'),source('brittle',1,'event','')]) assert.equal(applyCurse(h,bad).changed,false);
 assert.equal(JSON.stringify(h),before); applyCurse(h,source('brittle')); applyCurse(h,source('blood-debt')); assert.equal(h.curseSources.length,3);
});
test('encounter ledger prevents a second source for a hero and curse after cleanse or reload',()=>{
 const h=hero(),battle={}; const opts={battle,inBattle:true,encounterId:'boss'};
 applyCurse(h,source(),opts); reduceNaturalCurse(h,'withered',3);
 assert.equal(applyCurse(h,source('withered',2,'encounter','b'),JSON.parse(JSON.stringify(opts))).changed,false);
 assert.equal(effectiveTier(h,'withered'),0);
});
test('Ward blocks only next natural application in battle, no gear or out-of-battle consumption',()=>{
 const h=hero(),battle={curseWards:{mara:true}};
 applyCurse(h,source('brittle',1,'gear','slot'),{battle,inBattle:true}); assert.equal(battle.curseWards.mara,true);
 applyCurse(h,source('withered',1,'event','event'),{battle}); assert.equal(battle.curseWards.mara,true);
 assert.equal(applyCurse(h,source('blood-debt'),{battle,inBattle:true}).blocked,true); assert.equal(battle.curseWards.mara,false);
 assert.equal(applyCurse(h,source('blood-debt'),{battle,inBattle:true}).changed,true);
});
test('healing and Defense floor positive grants with a minimum of one',()=>{
 for(const [tier,expected] of [[1,17],[2,15],[3,13]]) {const h=hero();applyCurse(h,source('withered',tier));applyCurse(h,source('brittle',tier));for(const adjust of [adjustHealing,adjustDefense]){assert.equal(adjust(h,20),expected);assert.equal(adjust(h,1),1);assert.equal(adjust(h,0),0);}}
});
test('Blood Debt ignores defenses, leaves one HP and excludes downed/reserve',()=>{
 const h=hero(); h.ward=100;h.guard=true;applyCurse(h,source('blood-debt',3));assert.equal(bloodDebtDamage(h),3);h.hp=2;assert.equal(bloodDebtDamage(h),1);h.hp=1;assert.equal(bloodDebtDamage(h),0);h.hp=0;assert.equal(bloodDebtDamage(h),0);h.hp=20;h.bench=true;assert.equal(bloodDebtDamage(h),0);assert.equal(h.ward,100);
});
test('migration adds defaults without new legacy curses, consumes no RNG and rejects bad source atomically',()=>{
 const state={heroes:[{key:'mara',hp:8,atk:4,int:3,equipment:['hollow-band']}],pack:{equipment:[]},seed:42,battle:{rng:{seed:18}},bought:{a:true}};
 const result=migrateCurseState(state);assert.equal(result,state);assert.deepEqual(state.heroes[0].curseSources,[]); const snapshot=JSON.stringify(state);migrateCurseState(state);assert.equal(JSON.stringify(state),snapshot);
 const invalid={heroes:[hero(),{...hero(),curseSources:[source('withered',8)]}],pack:{}};const before=JSON.stringify(invalid);assert.equal(migrateCurseState(invalid),null);assert.equal(JSON.stringify(invalid),before);
});
test('Lantern selects highest natural tier then oldest source, limits per region and hero',()=>{
 const state={curseProgress:{lanternUses:{},freeCleansing:{}}},h=hero();applyCurse(h,source('withered',2,'event','e',4));applyCurse(h,source('brittle',2,'event','b',2));applyCurse(h,source('withered',3,'gear','slot',0));
 assert.equal(applyPilgrimLantern(state,h,1).curseId,'brittle');assert.equal(applyPilgrimLantern(state,h,1).curseId,'withered');assert.equal(applyPilgrimLantern(state,h,1).changed,false);assert.equal(effectiveTier(h,'withered'),3);
 assert.equal(applyPilgrimLantern(JSON.parse(JSON.stringify(state)),h,1).changed,false);assert.equal(applyPilgrimLantern(state,h,2).changed,true);
});
test('Fatigued effective stats never mutate base stats and floor at one',()=>{const h=hero(),battle={curseFatigue:{mara:true}};assert.equal(effectiveFatiguedStat(h,'atk',battle),2);assert.equal(effectiveFatiguedStat(h,'int',battle),1);assert.equal(effectiveFatiguedStat(h,'atk',{}),4);assert.equal(h.atk,4);});
