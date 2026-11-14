import test from 'node:test';
import assert from 'node:assert/strict';
import {map,regions,regionOf} from './expedition-data.mjs';
import {newRun,enter,resolve,restoreRun,buy,shopInventory,useRemedy} from './expedition-rules.mjs';

function encounter(node,options){
  const run=newRun(42,options);
  run.phase='map';
  run.node=Object.values(map).find(stop=>stop.next.includes(node.id)).id;
  assert.ok(enter(run,node.id));
  return run;
}

function defeat(run,enemy,die){
  enemy.hp=1;enemy.ward=0;enemy.guard=false;
  run.battle.defense.foe=0;
  die.face='strike';
  assert.ok(resolve(run,die.id,enemy.key));
}

test('KO earns Copper once, persists after reload, and the guided tutorial earns none',()=>{
  let run=encounter(map.road);
  const [first,second]=run.battle.enemies;
  defeat(run,first,run.battle.dice[0]);
  assert.equal(run.copper,4);
  assert.equal(run.phase,'battle');
  run=restoreRun(JSON.parse(JSON.stringify(run)));
  defeat(run,run.battle.enemies.find(e=>e.key===second.key),run.battle.dice[1]);
  assert.equal(run.copper,8);
  assert.equal(run.battle.copperEarned,8);
  assert.equal(resolve(run,run.battle.dice[0].id,first.key),null);
  assert.equal(run.copper,8);
  const tutorial=encounter(map.road,{tutorial:true});
  tutorial.tutorial.videoVersion=1;
  defeat(tutorial,tutorial.battle.enemies[0],tutorial.battle.dice[0]);
  assert.equal(tutorial.copper,0);
});

test('elite and boss income rises by region, coin fights add two per enemy',()=>{
  const expectedElite=[11,12,13,14,16],expectedBoss=[13,16,18,20,22];
  for(const region of regions){
    const elite=Object.values(map).find(node=>node.type==='elite'&&regionOf(node)===region);
    for(const [node,amount] of [[elite,expectedElite[region.number-1]],[map[region.boss],expectedBoss[region.number-1]]]){
      const run=encounter(node);
      defeat(run,run.battle.enemies[0],run.battle.dice[0]);
      assert.equal(run.copper,amount);
    }
  }
  const cache=encounter(map.cache);
  defeat(cache,cache.battle.enemies[0],cache.battle.dice[0]);
  assert.equal(cache.copper,6);
});

test('legacy Marks convert to Copper exactly once and only Copper is charged',()=>{
  const run=newRun(42);
  run.phase='shop';run.node='market';run.copper=5;run.marks=8;
  const migrated=restoreRun(run);
  assert.equal(migrated.copper,29);
  assert.equal(Object.hasOwn(migrated,'marks'),false);
  assert.equal(restoreRun(JSON.parse(JSON.stringify(migrated))).copper,29);
  const item=shopInventory(migrated).find(item=>item.id==='resin-buckle');
  assert.equal(Object.hasOwn(item,'markPrice'),false);
  assert.ok(buy(migrated,item.id));
  assert.equal(migrated.copper,29-item.price);
  const snapshot=structuredClone(migrated);
  assert.equal(buy(migrated,item.id),false);
  assert.deepEqual(migrated,snapshot);
  assert.equal(newRun(42).copper,0);
});

test('Hester takes Copper and purchased ward is usable',()=>{
  const run=newRun(42);run.phase='shop';run.node='wood-witch';run.copper=4;
  assert.equal(buy(run,'witchsalt-ward'),false);
  assert.equal(run.copper,4);
  run.copper=5;
  assert.ok(buy(run,'witchsalt-ward'));
  assert.equal(run.copper,0);
  assert.equal(shopInventory(run).find(item=>item.id==='witchsalt-ward').remaining,0);
  assert.ok(useRemedy(run,'witchsalt-ward',run.heroes[0].key).ok);
  assert.equal(run.heroes[0].pendingWitchsalt,true);
  assert.equal(run.pack.remedies['witchsalt-ward'],0);
});
