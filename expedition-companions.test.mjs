import test from 'node:test';
import assert from 'node:assert/strict';
import {newRun,enter,describe,resolve,endRound,restoreRun,rerollDice} from './expedition-rules.mjs';
import {companions,companionForHero} from './expedition-companions.mjs';

function fight(seed=42,id='flintback',tutorial=false){
  const state=newRun(seed,{tutorial});
  state.phase='map';state.node='threshold';
  assert.ok(enter(state,'road'));
  const bonded=state.heroes.find(hero=>companionForHero(hero)===id);
  if(bonded){
    bonded.bench=false;
    state.heroes=[bonded,...state.heroes.filter(hero=>hero!==bonded)];
  }else {
    state.heroes[0].id=id==='cindermoth'?'nera':'gideon';
  }
  return state;
}
function advance(state){
  for(const die of state.battle.dice.filter(d=>d.side==='foe'))die.spent=true;
  assert.ok(endRound(state));
}
function call(state){
  const die=state.battle.dice.find(d=>d.pool?.includes('summon'));
  assert.ok(die);
  die.face='summon';
  assert.ok(resolve(state,die.id));
  assert.equal(resolve(state,die.id),null);
}
test('one face among six and a matching observed chance; no summon in the tutorial',()=>{
  let rolled=0;
  for(let seed=1;seed<=2400;seed++){
    const state=fight(seed);
    const dice=state.battle.dice.filter(d=>d.pool?.includes('summon'));
    assert.equal(dice.length,1);
    assert.equal(new Set(dice[0].pool).size,6);
    rolled+=Number(dice[0].face==='summon');
  }
  assert.ok(Math.abs(rolled/2400-1/6)<.02, 'observed '+rolled/2400);
  assert.ok(!fight(42,'brinewisp',true).battle.dice.some(d=>d.pool?.includes('summon')));
});
test('all six companions apply their own abilities on arrival',()=>{
  for(const id of Object.keys(companions)){
    const state=fight(42,id);
    const owner=state.heroes[0], enemy=state.battle.enemies[0];
    owner.hp-=30;owner.bleed=2;owner.rooted=1;
    enemy.guard=false;enemy.ward=0;state.battle.defense.foe=0;
    const before=structuredClone(state);
    call(state);
    assert.equal(state.battle.companion.id,id);
    assert.equal(state.battle.companion.owner,owner.key);
    if(id==='brinewisp')assert.equal(enemy.hp,before.battle.enemies[0].hp-9);
    if(id==='flintback')assert.equal(owner.ward,before.heroes[0].ward+8);
    if(id==='chimewing')assert.equal(owner.hp,before.heroes[0].hp+10);
    if(id==='waxwing')assert.equal(enemy.mark,2);
    if(id==='cindermoth')assert.equal(enemy.bleed,3);
    if(id==='scriptfin'){assert.equal(owner.bleed+owner.rooted,0);assert.equal(owner.hp,before.heroes[0].hp+6);}
  }
});
test('two rounds, a single second pulse, and at most three summons across save and reroll',()=>{
  let state=fight(42,'flintback');
  const firstRound=state.battle.round;
  for(let count=1;count<=3;count++){
    call(state);
    const owner=state.heroes[0], initialWard=owner.ward;
    assert.equal(state.battle.summonCount,count);
    assert.equal(state.battle.companion.expiresAfter,firstRound+(count-1)*2+1);
    state=restoreRun(JSON.parse(JSON.stringify(state)));
    advance(state);
    assert.equal(state.heroes[0].ward,initialWard+8);
    assert.ok(state.battle.companion);
    assert.ok(!state.battle.dice.some(d=>d.pool?.includes('summon')));
    advance(state);
    assert.equal(state.battle.companion,null);
  }
  state.modifiers.rerollAll=true;rerollDice(state);
  assert.ok(!state.battle.dice.some(d=>d.pool?.includes('summon')));
  const die=state.battle.dice.find(d=>d.side==='party');die.face='summon';
  assert.ok(describe(state,die.id).reason);
  assert.equal(resolve(state,die.id),null);
});
test('spirit Defense and HP absorb attacks and depletion preserves duration',()=>{
  const state=fight(42,'brinewisp');
  call(state);
  const owner=state.heroes[0], before=owner.hp;
  owner.ward=0;state.battle.defense.party=0;owner.guard=false;
  const enemyDie=state.battle.dice.find(d=>d.side==='foe');enemyDie.face='foe-strike';
  const [change]=resolve(state,enemyDie.id).changes;
  assert.equal(change.spiritAbsorbed,7);
  assert.equal(owner.hp,before-change.loss);
  assert.equal(state.battle.companion.hp+state.battle.companion.defense,0);
  assert.equal(state.battle.companion.expiresAfter,state.battle.round+1);
});
test('second pulse can win the encounter and clears the active companion',()=>{
  const state=fight(42,'brinewisp');
  const [enemy,other]=state.battle.enemies;
  enemy.ward=0;enemy.hp=12;other.hp=0;
  call(state);
  assert.equal(enemy.hp,3);
  advance(state);
  assert.equal(state.phase,'reward');
  assert.equal(state.battle.companion,null);
});

test('shared Summon die follows the lead after a rotation and ignores old global loadouts',()=>{
  const state=fight();
  state.companionId='scriptfin';
  const summon=state.battle.dice.find(die=>die.pool?.includes('summon'));
  summon.face='summon';
  assert.equal(describe(state,summon.id).action.petId,'flintback');
  const rotate=state.battle.dice.find(die=>die.side==='party'&&die!==summon);
  rotate.face='rotate';
  assert.ok(resolve(state,rotate.id,'mara'));
  assert.equal(describe(state,summon.id).action.petId,'brinewisp');
  assert.ok(resolve(state,summon.id));
  assert.equal(state.battle.companion.owner,'mara');
  assert.equal(state.battle.companion.id,'brinewisp');
});
test('a legacy active summon restores to its owner bond without refreshing HP or charges',()=>{
  const state=fight();
  call(state);
  state.companionId='scriptfin';
  const pet=state.battle.companion;
  pet.id='scriptfin';pet.hp=3;pet.defense=1;
  const restored=restoreRun(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.companionId,undefined);
  assert.equal(restored.battle.summonCount,1);
  assert.deepEqual(restored.battle.companion,{...pet,id:'flintback'});
  const owner=restored.heroes[0],other=restored.heroes[1],otherWard=other.ward;
  owner.hp=0;
  advance(restored);
  assert.equal(restored.battle.companion.owner,owner.key);
  assert.equal(other.ward,otherWard);
});
