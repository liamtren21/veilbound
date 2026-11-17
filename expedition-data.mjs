export const heroes = [
  {id:'rook', name:'Rook Calder', role:'Vanguard', hp:136, atk:17, int:14, startDefense:6, strike:"Mason's Blow", reach:1,
    skills:['brace-line','stone-answer','take-weight'], relic:'witness-seal'},
  {id:'mara', name:'Mara Venn', role:'Skirmisher', hp:108, atk:20, int:20, startDefense:4, strike:'Oarhook', reach:2,
    skills:['undertow','open-seam','ferry-line'], relic:'ferrymans-knot'},
  {id:'elian', name:'Elian Reed', role:'Mender', hp:100, atk:16, int:16, startDefense:3, strike:'Tuning Strike', reach:2,
    skills:['mending-note','fracture-chime','clear-tone'], relic:'wayfarers-lamp'},
  {id:'tess', name:'Tess Ashdown', role:'Marksman', hp:94, atk:20, int:20, startDefense:3, strike:"Courier's Shot", reach:4,
    skills:['red-thread','pin-hem','final-delivery'], relic:'iron-needle'},
];

export const actions = {
  idle:{name:'Wait',type:'idle',target:'self',text:'Use this die without taking an action.'},
  'bulk-up':{name:'Bulk Up',type:'boost',target:'self',text:'The lead gains 2 attack until the end of the turn.'},
  strike:{name:'Strike', type:'hit', target:'enemy'},
  guard:{name:'Guard', type:'guard', target:'self', text:'Block the next attack.'},
  shift:{name:'Shift', type:'shift', target:'adjacent', text:'Swap formation slots with a living neighbor.'},
  brace:{name:'Brace', type:'ward', target:'self', amount:6, text:'Spend this die for 6 Defense.'},
  salve:{name:'Reed Salve', type:'heal', target:'wounded', maxHpFraction:.5, text:'Restore 50% of the target’s Max HP.'},
  'guard-token':{name:'Bark Ward', type:'guard', target:'self', text:'Give Guard to the current lead.'},
  'purify-token':{name:'Clearwater Seal', type:'cleanse', target:'self', text:'Remove the current lead’s debuffs.'},
  'heal-all':{name:'Juniper Draught', type:'heal', target:'self', maxHpFraction:.5, healTeam:true, text:'Restore 50% Max HP to each living warden.'},
  'full-heal-all':{name:'Full Juniper Draught', type:'heal', target:'self', maxHpFraction:1, healTeam:true, text:'Restore all HP to each living warden.'},
  'brace-line':{name:'Brace the Line', type:'ward', target:'adjacent', amount:18, cd:2, art:'brace', text:'Give a neighboring ally 18 Defense.'},
  'stone-answer':{name:'Stone Answer', type:'hit', target:'enemy', intBonus:0, cd:3, spendWard:true, text:'Hammer the front enemy and convert spent Defense into damage.'},
  'take-weight':{name:'Take the Weight', type:'cover', target:'other', cd:2, art:'cover', text:'Rook intercepts the next single-target hit this round.'},
  undertow:{name:'Undertow', type:'hit', target:'enemy', intBonus:3, pull:true, cd:2, text:'Damage an enemy within reach and pull smaller targets forward.'},
  'open-seam':{name:'Open Seam', type:'hit', target:'enemy', intBonus:-3, bleed:true, cd:1, text:'Cut an enemy and apply Bleed equal to STR. Bleed deals damage when the target’s team rotates.'},
  'ferry-line':{name:'Ferry Line', type:'shift', target:'other', amount:8, cd:2, art:'ferry', text:'Swap with a living ally and give both travelers 8 Defense.'},
  'mending-note':{name:'Mending Note', type:'heal', target:'wounded', intBonus:8, cd:1, text:'Restore HP equal to INT + 8 to one living hero.'},
  'fracture-chime':{name:'Fracture Chime', type:'hit', target:'enemy', intBonus:-2, crack:true, cd:2, text:'Damage an enemy and remove up to 2 remaining personal Defense.'},
  'clear-tone':{name:'Clear Tone', type:'cleanse', target:'afflicted', cd:1, text:'Remove Bleed or Rooted from one living ally.'},
  'red-thread':{name:'Red Thread', type:'mark', target:'enemy', cd:1, text:'Mark an enemy for two rounds. Attacks deal 4 extra damage to it.'},
  'pin-hem':{name:'Pin the Hem', type:'hit', target:'enemy', intBonus:-2, root:true, cd:2, text:'Damage and Root an enemy, preventing its next movement action.'},
  'final-delivery':{name:'Final Delivery', type:'hit', target:'enemy', intBonus:11, cd:3, text:'A heavy shot that can reach any enemy.'},
  'witness-seal':{name:'Witness Seal', type:'ward', target:'ally', amount:12, cd:2, art:'witness', text:'Give one living ally 12 Defense.'},
  'ferrymans-knot':{name:"Ferryman’s Knot", type:'ward', target:'ally', amount:12, cd:2, art:'ferry', text:'Give one living ally 12 Defense.'},
  'wayfarers-lamp':{name:"Wayfarer’s Lamp", type:'ward', target:'ally', amount:14, cd:2, text:'Give one living ally 14 Defense.'},
  'iron-needle':{name:'Iron Needle', type:'hit', target:'enemy', intBonus:2, pierce:true, cd:2, text:'Ignore squad and personal Defense.'},
};

export const foes = {
  bark:{name:'Bark Listener', art:'Bark Listener', hp:43, atk:12, startDefense:2, behavior:'stalker'},
  sap:{name:'Sap Runner', art:'Sap Runner', hp:36, atk:13, startDefense:1, behavior:'stalker'},
  thorn:{name:'Thorn Porter', art:'Thorn Porter', hp:58, atk:15, startDefense:3, behavior:'bulwark'},
  cradle:{name:'Empty Cradle', art:'Empty Cradle', hp:42, atk:12, startDefense:2, behavior:'bulwark'},
  bride:{name:'The Grafted Bride', art:'The Grafted Bride', hp:91, atk:17, startDefense:4, behavior:'stalker'},
  mother:{name:'Mother of Closed Doors', art:'mother-of-closed-doors', hp:148, atk:22, startDefense:5, behavior:'boss'},
  'reed-drifter':{name:'Reed Drifter', clip:'reed-drifter', hp:51, atk:15, startDefense:3, behavior:'stalker', strike:'lunge', technique:'pull'},
  'silt-grasper':{name:'Silt Grasper', clip:'silt-grasper', hp:62, atk:16, startDefense:5, behavior:'bulwark'},
  netkeeper:{name:'The Netkeeper', clip:'netkeeper', encounter:true, hp:108, atk:20, startDefense:7, behavior:'bulwark', technique:'pull'},
  'kiln-hound':{name:'Kiln Hound', art:'Sap Runner', hp:64, atk:18, startDefense:4, behavior:'stalker', strike:'lunge', technique:'thorn'},
  'coal-bearer':{name:'Coal Bearer', art:'Thorn Porter', hp:73, atk:18, startDefense:7, behavior:'bulwark'},
  'cinder-bailiff':{name:'The Cinder Bailiff', art:'The Grafted Bride', hp:128, atk:23, startDefense:8, behavior:'stalker'},
  'rust-hound':{name:'Rust Hound', art:'Sap Runner', hp:72, atk:20, startDefense:6, behavior:'stalker', strike:'pierce'},
  'toll-collector':{name:'Toll Collector', art:'Thorn Porter', hp:85, atk:21, startDefense:10, behavior:'bulwark'},
  'toll-engine':{name:'The Toll Engine', art:'Empty Cradle', hp:149, atk:25, startDefense:15, behavior:'bulwark'},
  'shale-crawler':{name:'Shale Crawler', art:'Sap Runner', hp:84, atk:23, startDefense:8, behavior:'stalker', strike:'pierce', technique:'root'},
  'clay-witness':{name:'Clay Witness', art:'Thorn Porter', hp:93, atk:24, startDefense:12, behavior:'bulwark'},
  'grave-surveyor':{name:'The Grave Surveyor', art:'The Grafted Bride', hp:170, atk:28, startDefense:13, behavior:'bulwark'},
  'bell-drowned':{name:'The Bell-Drowned', art:'bell-drowned', hp:184, atk:24, startDefense:8, behavior:'boss'},
  'kiln-that-hungers':{name:'The Kiln That Hungers', art:'kiln-that-hungers', hp:217, atk:27, startDefense:10, behavior:'boss'},
  'iron-procession':{name:'The Iron Procession', art:'iron-procession', hp:250, atk:30, startDefense:15, behavior:'boss'},
  'buried-magistrate':{name:'The Buried Magistrate', art:'buried-magistrate', hp:286, atk:33, startDefense:17, behavior:'boss'},
};

export const tokens={
  salve:{name:'Reed Salve',symbol:'✚',effect:'Restore 50% Max HP to a living warden.'},
  'guard-token':{name:'Bark Ward',symbol:'◆',effect:'Give Guard to the lead.'},
  'purify-token':{name:'Clearwater Seal',symbol:'✧',effect:'Remove debuffs from the lead.'},
  'heal-all':{name:'Juniper Draught',symbol:'✚',effect:'Restore 50% Max HP to each living warden.'},
  'full-heal-all':{name:'Full Juniper Draught',symbol:'✥',effect:'Fully heal each living warden.'},
};
export const tokenCapacity=5;
export const ferrymanStages = Object.freeze([
  { name: 'Base', defense: 3, window: null, text: 'Gain 3 personal Defense each time a rotation moves Mara into the lead.' },
  { name: 'Ascended', defense: 5, window: 'round', text: 'Gain 5 personal Defense on the first rotation into the lead each round.' },
  { name: 'Legendary', defense: 9, window: 'battle', text: 'Gain 9 personal Defense on the first rotation into the lead each battle.' },
]);

export const equipmentCapacity=5;
export const equipment={
  'bark-shield':{name:'Bark Shield',icon:3,trigger:'On Spawn',text:'Gain Guard when the battle starts.'},
  'resin-buckle':{name:'Resin Buckle',icon:4,trigger:'On Spawn',text:'Gain 6 personal Defense.'},
  'ferryman-cord':{name:'Ferryman’s Cord',icon:5,trigger:'Enter Lead',text:'Gain 3 personal Defense when a rotation moves the wearer into the lead.'},
  'juniper-beads':{name:'Juniper Beads',icon:6,trigger:'Turn Start',text:'Recover 3 HP at the start of each turn.'},
  'kiln-guard':{name:'Kiln Guard',icon:7,trigger:'On Spawn',tag:'Breakable',text:'Gain 10 personal Defense. Breaks if the wearer ends the battle knocked out.'},
  'hollow-band':{name:'Hollow Band',icon:8,trigger:'First Attack',tag:'Cursed',text:'Deal 4 extra damage on the wearer’s first attack. Cannot be removed once equipped.'},
  'rootcake':{name:'Rootcake',icon:1,trigger:'On Spawn / Battle End',tag:'Edible',text:'Start Rooted for one turn. If the wearer survives, consume this item to gain 2 Max HP for the rest of the run.'},
};
for(const [baseId,name,curse,boons,trigger] of [
  ['hollow-band','Hollow Band','withered',[4,6,8],'First Attack'],
  ['grave-plate','Grave Plate','blood-debt',[10,14,18],'On Spawn'],
  ['thorn-covenant','Thorn Covenant','brittle',[2,3,4],'Direct Hit'],
])for(let tier=1;tier<=3;tier++){
  const id=baseId+'-'+['i','ii','iii'][tier-1];
  equipment[id]={name:name+' '+['I','II','III'][tier-1],baseId,tier,curse,minRegion:[1,3,4][tier-1],boon:boons[tier-1],trigger,tag:'Cursed',
    text:`${trigger}: gain ${boons[tier-1]} ${baseId==='grave-plate'?'personal Defense':'direct damage'}. Applies ${curse} tier ${tier}. Equipped slot locks; destroy with Severance or Unbinding.`};
}
equipment['pilgrim-lantern']={name:'Pilgrim Lantern',minRegion:2,trigger:'Before On Spawn',text:'Lower all natural sources of one curse by one tier before battle. Highest natural tier, earliest received on ties. Twice per hero per region.'};
export const enemyCurses={mother:'withered','bell-drowned':'blood-debt','kiln-that-hungers':'withered','iron-procession':'brittle','buried-magistrate':'blood-debt',netkeeper:'blood-debt','cinder-bailiff':'withered','toll-engine':'brittle','grave-surveyor':'blood-debt'};
export const instantItems={
  'spiceberry':{name:'Spiceberry',icon:0,text:'Permanently gain 1 STR this run.'},
  'bitterberry':{name:'Bitterberry',icon:1,text:'Permanently gain 2 Max HP this run.'},
  'umami-broth':{name:'Umami Broth',icon:2,text:'Revive a fallen warden at 1 HP or heal a living warden by 10 HP.'},
};
export const enemyCopper={bark:4,sap:4,thorn:5,cradle:5,bride:8,mother:8};
export const training={
  strength:{label:'+3 STR',amount:3},
  health:{label:'+8 Max HP',amount:8},
  power:{label:'+2 INT',amount:2},
  slot:{label:'+1 equipment slot',amount:1},
};

export const intent = {
  rake:{name:'Root Scythe', type:'hit', rule:'front'},
  lunge:{name:'Briar Lunge', type:'hit', rule:'wounded'},
  thorn:{name:'Bitter Thorn', type:'hit', rule:'front', intBonus:-3, bleed:true},
  pierce:{name:'Splinter Spear', type:'hit', rule:'front', intBonus:-1, pierce:true},
  pull:{name:'Vine Hook', type:'pull', rule:'rear', intBonus:-4},
  root:{name:'Root Snare', type:'hit', rule:'rear', intBonus:-4, root:true},
  bark:{name:'Barkskin', type:'ward', amount:9},
  graft:{name:'Graft Link', type:'ward', amount:14, rule:'friend'},
  guard:{name:'Root Gate', type:'guard'},
  'foe-boost':{name:'Strengthen',type:'boost',permanent:true},
  'foe-purify':{name:'Purify',type:'cleanse'},
  'foe-target':{name:'Expose',type:'mark',rule:'party'},
  'foe-ranged':{name:'Range Attack',type:'hit',rule:'rear'},
  idle:{name:'Listen', type:'idle'},
  sweep:{name:'Three Door Buds', type:'hit', rule:'edges', intBonus:-4},
  siege:{name:'The Orchard Closes', type:'hit', rule:'party', intBonus:-6},
  'anchor-lash':{name:'Anchor Lash',type:'pull',rule:'rear',intBonus:-2},
  'toll-mark':{name:'Toll Mark',type:'mark',rule:'front'},
  'chain-sweep':{name:'Chain Sweep',type:'hit',rule:'edges',intBonus:-5},
  'drowned-surge':{name:'Drowned Surge',type:'hit',rule:'party',intBonus:-8},
  'furnace-snap':{name:'Furnace Snap',type:'hit',rule:'front',bleed:true},
  'gather-heat':{name:'Gather Heat',type:'boost'},
  'vent-burst':{name:'Vent Burst',type:'hit',rule:'edges',intBonus:-6},
  'consume-heat':{name:'Consume Heat',type:'hit',rule:'party',intBonus:-10,bleed:true},
  'blade-rake':{name:'Blade Rake',type:'hit',rule:'front',pierce:true,intBonus:-5},
  'guard-reversal':{name:'Guard Reversal',type:'ward',amount:13},
  'front-car-rake':{name:'Front Car Rake',type:'hit',rule:'edges',intBonus:-6},
  'final-toll':{name:'Final Toll',type:'hit',rule:'edges',intBonus:-4,pierce:true},
  'gravestone-claw':{name:'Gravestone Claw',type:'hit',rule:'front'},
  'stay-verdict':{name:'Stay Verdict',type:'hit',rule:'front',intBonus:-8,root:true},
  'move-verdict':{name:'Move Verdict',type:'hit',rule:'rear',intBonus:-6,root:true},
  'stone-decree':{name:'Stone Decree',type:'hit',rule:'party',intBonus:-10},
};
export const intentPools = {
  stalker:['rake','lunge','thorn','pierce','pull','idle'],
  bulwark:['rake','root','bark','graft','guard','pierce'],
  boss:['rake','sweep','root','graft','guard','thorn'],
};

export const regionalBossMoves={
  'bell-drowned':['anchor-lash','toll-mark','chain-sweep','drowned-surge'],
  'kiln-that-hungers':['furnace-snap','gather-heat','vent-burst','consume-heat'],
  'iron-procession':['blade-rake','guard-reversal','front-car-rake','final-toll'],
  'buried-magistrate':['gravestone-claw','move-verdict','stay-verdict','stone-decree'],
};

const node = (id, name, type, x, y, next, extra = {}) => ({id,name,type,x,y,next,...extra});
const chapters=[
  {id:'wood',name:'Hollow Orchard',entry:'threshold',boss:'sanctum',landscape:'orchard-expedition-panorama-v2.png'},
  {id:'water',name:'Drowned Causeway',entry:'causeway-entry',boss:'drowned-belfry',guardian:'bell-drowned',prefix:'causeway',gate:'Reedwatch Pier',
    road:'The Empty Ferry',elite:'The Netkeeper’s Weir',camp:'Reedwatch Rest',crossing:'The Silt Road',arena:'The Drowned Belfry',
    enemies:['reed-drifter','silt-grasper','netkeeper'],rest:'Lanterns mark the pier where the lost waited for a ferry that never came.'},
  {id:'fire',name:'Ember Terraces',entry:'terraces-entry',boss:'hunger-kiln',guardian:'kiln-that-hungers',prefix:'terraces',gate:'Cinder Steps',
    road:'The Warm Kiln',elite:'The Bailiff’s Vent',camp:'Ashfall Shelter',crossing:'The Cinder Causeway',arena:'The Hunger Kiln',
    enemies:['kiln-hound','coal-bearer','cinder-bailiff'],rest:'The heat stays in the bricks long after the fires die.'},
  {id:'metal',name:'Iron Mourning',entry:'mourning-entry',boss:'mourning-foundry',guardian:'iron-procession',prefix:'mourning',gate:'The Toll Bridge',
    road:'The Silent Foundry',elite:'The Toll Engine',camp:'Wirewatch Shelter',crossing:'The Rust Walk',arena:'The Mourning Foundry',
    enemies:['rust-hound','toll-collector','toll-engine'],rest:'A broken toll bell hangs above a dry place to rest.'},
  {id:'earth',name:'Pale Basin',entry:'basin-entry',boss:'sunken-tribunal',guardian:'buried-magistrate',prefix:'basin',gate:'The Namewell',
    road:'Buried Court',elite:'The Surveyor’s Cairn',camp:'Whitebank Rest',crossing:'The Shale Road',arena:'The Sunken Tribunal',
    enemies:['shale-crawler','clay-witness','grave-surveyor'],rest:'The wardens read names in the clay as Juniper tends their wounds.'},
];
export const regions=chapters.map((chapter,index)=>({...chapter,number:index+1,
  landscape:chapter.landscape??'boss-arena-'+chapter.id+'-v1.png'}));

const regionalNodes=regions.slice(1).flatMap(region=>{
  const {prefix,entry,boss,gate,road,elite,camp,crossing,arena,enemies,landscape,id}=region;
  const [scout,guard,champion]=enemies;
  const stop=(key,name,type,x,y,next,foes)=>node(key,name,type,x,y,next,{region:id,art:landscape,enemies:foes});
  return [
    stop(entry,gate,'story',10,50,[prefix+'-road']),
    stop(prefix+'-road',road,'battle',27,50,[prefix+'-elite',prefix+'-camp'],[scout,guard]),
    stop(prefix+'-elite',elite,'elite',47,25,[prefix+'-crossing'],[champion]),
    stop(prefix+'-camp',camp,'camp',47,75,[prefix+'-crossing']),
    stop(prefix+'-crossing',crossing,'coin',68,50,[id+'-witch'],[guard,scout]),
    node(id+'-witch','Wren’s Hex Remedies','merchant',78,50,[boss],{region:id,vendor:'hester',art:landscape}),
    stop(boss,arena,'boss',94,50,[],[region.guardian]),
  ];
});
export const nodes = [
  node('threshold','Orchard Gate','story',10,49,['road'],{art:'orchard-threshold'}),
  node('road','The Listening Road','battle',24,49,['cache','creek','house'],{enemies:['bark','sap'],art:'orchard-threshold'}),
  node('cache','Tollkeeper’s Cache','coin',37,23,['market','graft'],{enemies:['sap','sap'],art:'resin-creek'}),
  node('creek','Resin Crossing','crossing',37,49,['market','camp'],{art:'resin-creek'}),
  node('house','The Doorless House','hidden',37,76,['camp','market'],{art:'doorless-house'}),
  node('market','Root Market','merchant',51,21,['bridge','memorial'],{art:'root-market'}),
  node('graft','Graft Watch','elite',51,49,['memorial'],{enemies:['bride'],art:'resin-creek'}),
  node('camp','Juniper Camp','camp',51,77,['memorial','salvage'],{art:'doorless-house'}),
  node('bridge','Thorn Bridge','battle',65,20,['memorial'],{enemies:['thorn','cradle'],art:'resin-creek'}),
  node('memorial','The Names on the Door','story',65,49,['trainer'],{art:'doorless-house'}),
  node('trainer','The Juniper Mentor','camp',76,63,['sable','wood-witch'],{art:'doorless-house'}),
  node('salvage','The Abandoned Kiln','supply',65,77,['memorial'],{art:'resin-creek'}),
  node('sable','Wayfarer’s Wick','merchant',78,23,['wood-witch'],{art:'root-market'}),
  node('wood-witch','Wren’s Hex Remedies','merchant',83,65,['sanctum'],{vendor:'hester',art:'root-market'}),
  node('sanctum','Sanctum of Closed Doors','boss',94,49,[],{enemies:['mother'],art:'boss-arena-wood-v1.png'}),
  ...regionalNodes,
];
export const map = Object.fromEntries(nodes.map(item => [item.id,item]));
export const regionOf=node=>regions.find(region=>region.id===node?.region)??regions[0];
export const nodeTypes = {
  story:['Story','Story'], battle:['Battle','Battle'], coin:['Copper fight','Battle'], crossing:['Crossing','Crossing'],
  hidden:['Hidden trail','Hidden Trail'], merchant:['Merchant','Merchant'], elite:['Elite','Elite'],
  camp:['Camp','Camp'], supply:['Supply cache','Supply Cache'], boss:['Boss','Boss'],
};
export const stock = {
  market:[{id:'salve',price:[4,8]},{id:'guard-token',price:[4,8]},{id:'resin-buckle',price:[16,20]},{id:'juniper-beads',price:[16,20]}],
  sable:[{id:'purify-token',price:[4,8]},{id:'salve',price:[4,8]},{id:'ferryman-cord',price:[16,20]},{id:'kiln-guard',price:[16,20]},
    {id:'charm',name:'Bramble Charm',price:[16,20],text:'Start the boss fight with 8 shared Squad Defense.'}],
};
export const story = {
  threshold:{copy:'No one has come through the orchard since the night its doors began remembering the dead. Four wardens arrive with one task: carry the names of the missing to the keeper.', choices:[['enter','Enter the orchard','Begin the expedition.']]},
  creek:{copy:'The footbridge is gone. Resin holds a narrow line between the roots, and an old toll lantern burns above the water.',choices:[['ford','Wade through the creek','Spend 8 HP from each living hero and recover 18 Copper.'],['toll','Pay the keeper','Spend 8 Copper to cross without injury.']]},
  house:{copy:'A letter is wedged between a doorframe and the tree that swallowed it. Mara recognizes the name on the fold.',choices:[['letter','Carry the letter','Keep the Lost Letter. It weakens the Mother’s opening Defense.'],['supplies','Take the emergency satchel','Gain two Reed Salves.']]},
  camp:{copy:'Juniper has kept a pot warm by the trail. For the fallen, there is enough light left to call one name back.',choices:[['rest','Rest by the fire','Restore 26 HP to all living heroes.'],['revive','Call a fallen warden','Revive the first fallen hero at 35 HP.']]},
  memorial:{copy:'Every door in the orchard bears a name. Rook finds a strip of Heartwood carved with the names of all four wardens.',choices:[['remember','Speak the names aloud','Receive one Heartwood and restore 12 HP to each living hero.']]},
  salvage:{copy:'The old kiln still shelters a sealed basket and a purse that no one came back for.',choices:[['salvage','Open the basket','Gain one Reed Salve and 14 Copper.']]},
  ...Object.fromEntries(regions.slice(1).map(region=>[region.prefix+'-camp',{copy:region.rest,choices:[
    ['rest','Rest by the fire','Restore 50% Max HP to all living wardens.'],
    ['revive','Call a fallen warden','Revive one fallen warden at 35 HP.'],
  ]}])),
};

for(const region of regions.slice(1))story[region.entry]={copy:'A bound spirit offers Copper for a willing bearer of its curse.',choices:[['leave','Pass without a bargain','Leave freely.'],['bargain','Accept a curse bargain','Choose a hero and curse. Tier and Copper reward are shown before acceptance.']]};

export const STORY_VERSION = 1;
export const storyOpportunities = Object.freeze({
  memorial: { id:'deliver-letter', label:'Deliver the Lost Letter',
    description:'Give the Lost Letter to the Namekeeper. The Mother loses 14 opening Squad Defense.',
    cost:{letter:1}, boss:'sanctum', reduction:14 },
  'causeway-camp': { id:'sound-the-reed-bell', label:'Sound the reed bell',
    description:'Offer 6 Copper. The Drowned Belfry starts with 6 less Ward.',
    cost:{copper:6}, boss:'drowned-belfry', reduction:6 },
  'terraces-camp': { id:'cool-the-embers', label:'Cool the embers',
    description:'Use a Reed Salve to protect the guide. The Hunger Kiln starts with 8 less Ward.',
    cost:{salve:1}, boss:'hunger-kiln', reduction:8 },
  'mourning-camp': { id:'repair-the-toll-chain', label:'Repair the toll chain',
    description:'Offer 10 Copper to the smith. The Mourning Foundry boss starts with 10 less Ward.',
    cost:{copper:10}, boss:'mourning-foundry', reduction:10 },
  'basin-camp': { id:'read-the-lost-names', label:'Read the lost names',
    description:'Offer one Heartwood to the keeper. The Sunken Tribunal boss starts with 12 less Ward.',
    cost:{heartwood:1}, boss:'sunken-tribunal', reduction:12 },
});

export function storyOffer(state) {
  if (state?.storyVersion !== STORY_VERSION || state.phase !== 'event') return null;
  const offer = Object.hasOwn(storyOpportunities, state.node) && storyOpportunities[state.node];
  if (!offer) return null;
  const eligible = Object.entries(offer.cost).every(([item, amount]) =>
    (item === 'copper' ? state.copper : state.pack[item] ?? 0) >= amount);
  if (offer.id === 'deliver-letter' && !eligible) return null;
  return { ...offer, eligible };
}

export function storyChoices(state) {
  const choices = story[state.node]?.choices ?? [];
  if (state.storyVersion !== STORY_VERSION || state.node !== 'house') return choices;
  return choices.map(([id, label, description]) => [id, label, id === 'letter'
    ? 'Take the Lost Letter to the Namekeeper before facing the Mother.' : description]);
}

export const storyPresentation = {
  threshold:{speaker:'Mara Venn',hero:'mara',backdrop:'event-scene-threshold.webp',
    inspect:['Read the gate marker','The road leads past a broken crossing and the old orchard house. Pick your two technique faces before you go.']},
  creek:{speaker:'The Tollkeeper',portrait:'event-tollkeeper-v1.webp',backdrop:'event-scene-creek.webp',
    inspect:['Test the crossing','The lantern marks the safe stones. Below them, a purse is caught in the roots. The current is strong enough to injure every living warden.']},
  house:{speaker:'The Letter Keeper',portrait:'event-letter-keeper-v1.webp',backdrop:'event-scene-house.webp',
    inspect:['Examine the seal','The seal bears the Mother’s mark. Carrying the letter weakens her opening Defense. The satchel contains two Reed Salves.']},
  camp:{speaker:'Orin Thatch',portrait:'wood-npc-orin-thatch-v2.png',backdrop:'event-scene-camp.webp',
    inspect:['Check the party','The fire can tend everyone still standing, or you can use it to call back one fallen warden.']},
  memorial:{speaker:'The Namekeeper',portrait:'event-namekeeper-v1.webp',backdrop:'event-scene-memorial.webp',
    inspect:['Read the carved names','Your names are already on the Heartwood. Speak them aloud to take it and heal the party.']},
  salvage:{speaker:'Rook Calder',hero:'rook',backdrop:'event-scene-salvage.webp',
    inspect:['Inspect the basket','The kiln baked the latch shut. A Reed Salve and a purse of 14 Copper survived inside.']},
  'causeway-entry':{backdrop:'event-scene-causeway-entry.webp',
    inspect:['Read the mooring stones','The spirit’s price is carved into the stones. Choose a warden and a curse to see the terms.']},
  'causeway-camp':{speaker:'Mara Venn',hero:'mara',backdrop:'event-scene-causeway-camp.webp',
    inspect:['Examine the camp','The reed bell can still be sounded. Six Copper will pay for the work.']},
  'terraces-entry':{backdrop:'event-scene-terraces-entry.webp',
    inspect:['Inspect the scorched marks','The spirit’s offer is stronger here. Check which curse and tier a warden would carry before accepting.']},
  'terraces-camp':{speaker:'Rook Calder',hero:'rook',backdrop:'event-scene-terraces-camp.webp',
    inspect:['Examine the camp','A Reed Salve will protect the guide while the embers are quenched.']},
  'mourning-entry':{backdrop:'event-scene-mourning-entry.webp',
    inspect:['Examine the toll chain','The chain is stamped with the promise of Copper. The warden who accepts pays with a tier III curse.']},
  'mourning-camp':{speaker:'Rook Calder',hero:'rook',backdrop:'event-scene-mourning-camp.webp',
    inspect:['Examine the camp','The smith can save the toll chain for ten Copper.']},
  'basin-entry':{backdrop:'event-scene-basin-entry.webp',
    inspect:['Peer into the well','There is no water. The spirit still offers Copper and its strongest curse to a warden who will bear it.']},
  'basin-camp':{speaker:'Elian Reed',hero:'elian',backdrop:'event-scene-basin-camp.webp',
    inspect:['Examine the camp','One Heartwood will hold the names long enough to read them aloud.']},
};
for(const region of regions.slice(1)){
  const entry=storyPresentation[region.entry];
  Object.assign(entry,{speaker:'The Bound Spirit',portrait:'event-bound-spirit-v1.webp'});
  const campId=region.prefix+'-camp';
  storyPresentation[campId]={...storyPresentation.camp,...storyPresentation[campId]};
}
