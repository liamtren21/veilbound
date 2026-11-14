import test from 'node:test';
import assert from 'node:assert/strict';
import {nodes,map,regions,regionOf} from './expedition-data.mjs';
import {newRun,enter,leaveShop,restoreRun,chooseEvent,bargainPreview} from './expedition-rules.mjs';

test('every path across each region reaches one witch immediately before its boss',()=>{
 for(const region of regions){
  const witches=nodes.filter(n=>regionOf(n).id===region.id&&n.vendor==='hester');
  assert.equal(witches.length,1);assert.deepEqual(witches[0].next,[region.boss]);
  let paths=0;
  function walk(id,seen=[]){assert.ok(!seen.includes(id));const path=[...seen,id];if(id===region.boss){paths++;assert.ok(path.includes(witches[0].id));return;}for(const next of map[id].next)walk(next,path);}
  walk(region.entry);assert.ok(paths>0);
 }
});
test('shop Continue and boss Continue retain position, visitation and stocks',()=>{
 const run=newRun(42);run.phase='map';run.node='trainer';assert.ok(enter(run,'wood-witch'));
 run.shopRemedyStock={'wood-witch':{'ashwater-phial':0}};
 const resumed=restoreRun(structuredClone(run));assert.equal(resumed.phase,'shop');assert.equal(resumed.shopRemedyStock['wood-witch']['ashwater-phial'],0);
 assert.ok(leaveShop(resumed));assert.ok(enter(resumed,'sanctum'));
 assert.equal(restoreRun(structuredClone(resumed)).node,'sanctum');
});
test('bargain reveals exact hero tier/reward; no duplicate or free Ward event reward',()=>{
 const run=newRun(42);run.node='causeway-entry';run.phase='event';run.heroes[0].pendingWitchsalt=true;
 const p=bargainPreview(run,run.heroes[0].key,'withered');assert.equal(p.tier,1);assert.equal(p.copper,8);
 assert.ok(chooseEvent(run,'bargain',run.heroes[0].key,'withered'));assert.equal(run.copper,8);assert.equal(run.heroes[0].curseSources.length,1);assert.equal(run.heroes[0].pendingWitchsalt,true);
 run.phase='event';assert.equal(chooseEvent(run,'bargain',run.heroes[0].key,'brittle'),false);assert.equal(run.copper,8);
});
