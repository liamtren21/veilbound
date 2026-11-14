import test from 'node:test';
import assert from 'node:assert/strict';
import {equipment,map,regions} from './expedition-data.mjs';
import {nextSeed} from './expedition-dice-rng.mjs';
import {dicePainting} from './expedition-dice-paint.mjs';
import {applyCurse,effectiveTier} from './expedition-curses.mjs';
import {newRun,restoreRun,enter,endRound,resolve,describe,moveEquipment,rewardOffer,scheduleCurses,claim,buy,shopInventory,fieldSalve} from './expedition-rules.mjs';
function battle(region=1){const s=newRun(42);s.phase='map';s.node=map[regions[region-1].boss].id;s.node=Object.values(map).find(n=>n.next.includes(regions[region-1].boss)).id;assert.ok(enter(s,regions[region-1].boss));return s;}
function next(s){for(const die of s.battle.dice.filter(d=>d.side==='foe'))die.spent=true;assert.ok(endRound(s));}
const successfulRollSeed=Array.from({length:100},(_,i)=>i+1).find(seed=>Math.abs(nextSeed(seed))%100<20);
function nextWithCurse(s){s.battle.rng.curse=successfulRollSeed;next(s);}
const curse=(h,id,tier=1,sourceId='natural')=>applyCurse(h,{curseId:id,tier,sourceType:'event',sourceId});

test('new run and legacy restore preserve stats, rolls, RNG and legacy Hollow Band',()=>{
 const s=battle();s.heroes[0].equipment=['hollow-band'];delete s.curseVersion;delete s.heroes[0].curseSources;
 const before=structuredClone(s.battle);const hp=s.heroes.map(h=>h.hp);assert.ok(restoreRun(s));assert.deepEqual(s.battle,before);assert.deepEqual(s.heroes.map(h=>h.hp),hp);assert.deepEqual(s.heroes[0].curseSources,[]);
 assert.deepEqual(restoreRun(structuredClone(s)),s);assert.deepEqual(newRun(42).pack.remedies,{});
});
test('gear variants require consent, reject base duplicates, lock slots, survive restore and tier-filter loot',()=>{
 const s=newRun(42),h=s.heroes[0];h.equipment=[null,null];s.pack.equipment=['hollow-band-i','hollow-band-ii'];
 assert.equal(moveEquipment(s,h.key,0,0),false);assert.ok(moveEquipment(s,h.key,0,0,{confirmed:true}));assert.equal(effectiveTier(h,'withered'),1);assert.equal(moveEquipment(s,h.key,1,0,{confirmed:true}),false);assert.equal(moveEquipment(s,h.key,0),false);
 assert.equal(restoreRun(structuredClone(s)).heroes[0].equipment[0],'hollow-band-i');
 for(let region=1;region<=5;region++){const r=battle(region);r.phase='reward';const offer=rewardOffer(r);assert.ok(offer.gear.every(id=>id!=='hollow-band'&&(equipment[id].minRegion??1)<=region));assert.deepEqual(rewardOffer(restoreRun(structuredClone(r))),offer);}
});
test('Lantern before spawn Defense, once-entry usage, turn heal before nonlethal debt, reserve excluded',()=>{
 const s=newRun(42),h=s.heroes[0];h.equipment=['pilgrim-lantern','resin-buckle'];curse(h,'brittle',2);curse(h,'blood-debt',3,'debt');s.heroes[3].hp=10;curse(s.heroes[3],'blood-debt',3,'bench');
 s.phase='map';s.node='wood-witch';assert.ok(enter(s,'sanctum'));assert.equal(effectiveTier(h,'blood-debt'),2);assert.equal(s.curseProgress.lanternUses[1][h.key],1);assert.equal(s.heroes[3].hp,10);
 const before=structuredClone(s);restoreRun(s);assert.deepEqual(s,before);const hp=h.hp;next(s);assert.equal(h.hp,hp-2);
 const b=battle(),lead=b.heroes[0];lead.equipment=['juniper-beads'];lead.hp=5;curse(lead,'withered',3);curse(lead,'blood-debt',3,'debt');next(b);assert.equal(lead.hp,3);lead.hp=1;next(b);assert.equal(lead.hp,1);
});
test('Withered field heal, Fatigued effective attack only and active Ward expire at battle end',()=>{
 const s=newRun(42),h=s.heroes[0];s.phase='map';s.pack.salve=1;h.hp=1;curse(h,'withered',3);assert.ok(fieldSalve(s,h.key));assert.equal(h.hp,1+Math.floor(Math.trunc(h.maxHp/2)*.65));
 const r=newRun(42),a=r.heroes[0];a.pendingFatigue=true;a.pendingWitchsalt=true;const atk=a.atk;r.phase='map';r.node='wood-witch';enter(r,'sanctum');assert.equal(a.atk,atk);assert.ok(r.battle.curseFatigue[a.key]);
 const foe=r.battle.enemies[0];foe.guard=false;foe.ward=0;r.battle.defense.foe=0;r.battle.dice.find(d=>d.id==='party0').face='strike';const hp=foe.hp;resolve(r,'party0',foe.key);assert.equal(hp-foe.hp,atk-2);
 foe.hp=1;r.battle.dice.find(d=>d.id==='party1').face='strike';resolve(r,'party1',foe.key);assert.equal(r.phase,'reward');assert.deepEqual(r.battle.curseWards,{});assert.deepEqual(r.battle.curseFatigue,{});
});
test('curse telegraph fixed locked targets, one Ward, no retarget or replay; preserves dice count and boss combo',()=>{
 const s=battle(4),count=s.battle.dice.length;s.heroes[0].guard=true;s.battle.curseWards[s.heroes[0].key]=true;nextWithCurse(s);assert.equal(s.battle.dice.length,count);
 const d=s.battle.dice.find(d=>d.curse),p=describe(s,d.id);assert.equal(d.fixed,true);assert.equal(p.action.tier,3);assert.equal(p.targets.length,2);assert.match(p.action.text,/Bypasses Guard/);const keys=d.curse.targets.slice();
 s.heroes.reverse();const result=resolve(s,d.id);assert.ok(result);assert.equal(effectiveTier(s.heroes.find(h=>h.key===keys[0]),'brittle'),0);assert.equal(effectiveTier(s.heroes.find(h=>h.key===keys[1]),'brittle'),3);assert.equal(s.heroes.find(h=>h.key===keys[0]).guard,true);assert.equal(resolve(s,d.id),null);
 const dead=battle(4);nextWithCurse(dead);const lock=dead.battle.dice.find(d=>d.curse);const untouched=dead.heroes.find(h=>!lock.curse.targets.includes(h.key)&&!h.bench);for(const key of lock.curse.targets)dead.heroes.find(h=>h.key===key).hp=0;assert.ok(resolve(dead,lock.id));assert.equal(untouched.curseSources.length,0);
});
test('region five boss can roll consecutively, capped at six; reload cannot roll twice',()=>{
 const s=battle(5);
 for(let i=0;i<6;i++){
   nextWithCurse(s);
   assert.equal(s.battle.dice.filter(d=>d.curse).length,1);
   assert.equal(s.battle.dice.find(d=>d.id==='boss0').curse,undefined);
   const reloaded=restoreRun(structuredClone(s));
   const before=structuredClone(reloaded.battle);
   scheduleCurses(reloaded);
   assert.deepEqual(reloaded.battle,before);
 }
 nextWithCurse(s);assert.ok(!s.battle.dice.some(d=>d.curse));
 const dead=battle();nextWithCurse(dead);const die=dead.battle.dice.find(d=>d.curse);dead.battle.enemies[0].hp=0;assert.equal(resolve(dead,die.id),null);
});
test('ordinary foes roll and apply a single-target curse with a renderable die face',()=>{
 const s=newRun(42);s.phase='map';s.node='threshold';assert.ok(enter(s,'road'));
 const count=s.battle.dice.length;
 nextWithCurse(s);
 const die=s.battle.dice.find(d=>d.curse);
 assert.equal(s.battle.dice.length,count);
 assert.equal(die.curse.targets.length,1);
 assert.equal(die.curse.tier,1);
 assert.ok(dicePainting(describe(s,die.id).actor.id,'curse','foe'));
 assert.ok(resolve(s,die.id));
 assert.equal(effectiveTier(s.heroes[0],'withered'),1);
 nextWithCurse(s);assert.ok(s.battle.dice.some(d=>d.curse));
 nextWithCurse(s);assert.ok(!s.battle.dice.some(d=>d.curse));
 const tutorial=newRun(42,{tutorial:true});tutorial.phase='map';tutorial.node='threshold';assert.ok(enter(tutorial,'road'));
 nextWithCurse(tutorial);assert.ok(!tutorial.battle.dice.some(d=>d.curse));
});
test('merchant buy adapter separates Remedies and combat tokens and persists stock',()=>{
 const s=newRun(42);s.node='wood-witch';s.phase='shop';s.copper=50;assert.equal(shopInventory(s).find(x=>x.id==='ashwater-phial').price,6);assert.ok(buy(s,'ashwater-phial'));assert.ok(buy(s,'ashwater-phial'));assert.equal(buy(s,'ashwater-phial'),false);assert.equal(s.pack.remedies['ashwater-phial'],2);assert.equal(s.pack.salve,0);assert.equal(buy(restoreRun(structuredClone(s)),'ashwater-phial'),false);
});

test('Hollow first hit consumes on Clash retaliation source',()=>{
 const s=battle(),h=s.heroes[0];h.equipment=['hollow-band-i'];const foe=s.battle.enemies[0];foe.hp=foe.maxHp=500;foe.atk=1;foe.ward=0;foe.guard=false;s.battle.defense.foe=0;s.battle.defense.party=0;
 const dice=s.battle.dice.filter(d=>d.side==='foe');for(const d of dice)d.face='clash';
 const first=resolve(s,dice[0].id),second=resolve(s,dice[1].id);assert.equal(first.changes[1].loss,h.atk+4);assert.equal(second.changes[1].loss,h.atk);assert.equal(h.firstAttackUsed,true);
});
test('only final boss victory clears all curses immediately, including equipment and reserve sources',()=>{
 for(const region of [1,5]){const s=battle(region),h=s.heroes[0];curse(h,'withered',3);applyCurse(s.heroes[3],{curseId:'brittle',tier:3,sourceType:'gear',sourceId:'tess:slot:0'});const foe=s.battle.enemies[0];foe.hp=1;foe.guard=false;foe.ward=0;s.battle.defense.foe=0;s.battle.dice[0].face='strike';resolve(s,s.battle.dice[0].id,foe.key);assert.equal(effectiveTier(h,'withered'),region===5?0:3);assert.equal(effectiveTier(s.heroes[3],'brittle'),region===5?0:3);assert.ok(claim(restoreRun(s),'leave'));assert.equal(s.phase,region===5?'complete':'event');}
});
test('Grave Defense respects Brittle, Thorn and Hollow add only direct damage before Guard',()=>{
 const s=newRun(42),h=s.heroes[0];h.equipment=['grave-plate-iii'];curse(h,'brittle',3);s.phase='map';s.node='wood-witch';enter(s,'sanctum');assert.equal(h.ward,Math.floor(18*.65)+Math.floor(5*.65));
 const r=battle(),a=r.heroes[0],foe=r.battle.enemies[0];a.equipment=['thorn-covenant-iii','hollow-band-iii'];foe.ward=0;r.battle.defense.foe=0;foe.guard=true;const die=r.battle.dice[0];die.face='strike';assert.equal(resolve(r,die.id,foe.key).changes[0].loss,0);assert.equal(a.firstAttackUsed,true);
});
