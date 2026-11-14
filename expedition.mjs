import {actions, equipment, equipmentCapacity, heroes, instantItems, intent, map, nodes, nodeTypes, regionOf, regions, story, tokenCapacity, tokens, training} from './expedition-data.mjs';
import {active, available, buy, canEndRound, canEngrave, chooseEvent, claim, configure, currentNode, describe, dieActor, dieFaces, discardEquipment, endRound, enter, equipBarkShield, faceKey, fieldSalve, hasEquipment, hasTutorialLoot, isScriptedDie, leaveShop, living, moveEquipment, newRun, nextRegion, pendingEnemyDice, rerollableDice, rerollDice, resolve, restoreRun, rewardOffer, shopInventory, tokenCount, tutorialLoot, visitTrainer,previewRemedy,useRemedy} from './expedition-rules.mjs?v=copper-wallet-v1';
import {canAffordCopper} from './expedition-economy.mjs';
import {REMEDY_CATALOG,REMEDY_CAPACITY,remedyCount} from './expedition-remedies.mjs';
import {CURSE_DEFINITIONS} from './expedition-curses.mjs';
import {companions,companionForHero,SUMMON_LIMIT,SUMMON_FACE} from './expedition-companions.mjs';
import {displayFaces} from './expedition-dice-rng.mjs';
import {createJourney, lessonPage} from './expedition-journey.mjs?v=menu-session-v1';
import {trialLabel} from './expedition-progression.mjs';
import {asset, createArena, routeIcon, wardenPreview} from './expedition-art.mjs?v=companion-bond-v2';
import {applySettings,settings,cue} from './expedition-options.mjs';
import {cinematic,motionWindow} from './expedition-cinematics.mjs';
import {paintDiceFace,framedSkill} from './expedition-dice-paint.mjs?v=companion-bond-v2';
import {createDiceVfx} from './expedition-dice-vfx.mjs?v=orbit-v25';
import {beats} from './expedition-motion-library.mjs';

const $=id=>document.getElementById(id);
const expeditionId=new URLSearchParams(location.search).get('expedition');
let remoteRun,pendingRemoteAction;
const routeChoices=()=>remoteRun ? remoteRun.availableNodes.map(node=>node.id) : available(state);
const storage='veilbound-hollow-orchard-v1';
const fresh=(tutorial=false,options={})=>newRun(crypto.getRandomValues(new Uint32Array(1))[0],{tutorial,...options});
let savedRunAvailable=false;
let journey;
const reduced=()=>settings.motion;
const diceVfx=createDiceVfx($('combat'),reduced);
$('reduced').onchange=()=>applySettings({motion:$('reduced').checked});
applySettings({});
const arena=createArena($('battlefield'),reduced,$('action-flash'));
let state=load();
let selection=null;
let busy=false;
let rollStamp=state.phase==='battle'&&(!lessonPage(state)||['light','dark','controls'].includes(lessonPage(state)[0]))?state.node+':'+state.battle.round:'';
let rollingDice=null;
let onConfirm;
let lastStage;
const utilities=[...document.querySelectorAll('.utility')];
for(const menu of utilities)menu.addEventListener('toggle',()=>{
  if(menu.open)for(const other of utilities)if(other!==menu)other.open=false;
});
document.addEventListener('pointerdown',event=>{
  for(const menu of utilities)if(!menu.contains(event.target))menu.open=false;
});
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||$('confirmation').open)return;
  const menu=utilities.find(entry=>entry.open);
  if(menu){menu.open=false;menu.querySelector('summary').focus();}
  else if(selection&&!busy){selection=null;renderCombat();}
  else if(!busy&&!document.querySelector('main').inert){
    if(expeditionId)$('settings').open=!$('settings').open;
    else journey?.pause();
  }
});
const fullscreen=$('fullscreen');
fullscreen.hidden=!document.fullscreenEnabled;
fullscreen.onclick=async()=>{
  try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}
  catch{$('announcement').textContent='Full screen is unavailable.';}
};
document.addEventListener('fullscreenchange',()=>fullscreen.textContent=document.fullscreenElement?'Exit full screen':'Full screen');

function load(){
  try{
    const saved=JSON.parse(localStorage.getItem(storage));
    const restored=restoreRun(saved);
    if(restored){
      const tutorial=restored.tutorial;
      if(tutorial.enabled&&Number.isInteger(tutorial.introPage)&&tutorial.videoVersion!==1){
        tutorial.introPage=[1,2,3,0,4,6,7,8][tutorial.introPage]??9;tutorial.videoVersion=1;
      }
      if(!restored.runId&&!['complete','defeat'].includes(restored.phase)){
        restored.runId=crypto.randomUUID();
        if(restored.benchKey==='rook')restored.talisman='river';
        if(restored.benchKey==='mara')restored.talisman='lantern';
      }
      savedRunAvailable=true;return restored;
    }
  }catch{}
  return fresh();
}
function save(){
  if(expeditionId)return;
  try{localStorage.setItem(storage,JSON.stringify(state));savedRunAvailable=true;}
  catch{$('save-status').textContent='This browser could not save the expedition.';}
  journey?.recordProgress();
}
function html(tag,value='',className=''){
  const el=document.createElement(tag);
  if(value)el.textContent=value;
  if(className)el.className=className;
  return el;
}
function button(label,callback,options={}){
  const el=html('button',label,options.className);
  el.type='button';
  el.disabled=Boolean(options.disabled);
  el.onclick=callback;
  if(options.caption)el.append(html('small',options.caption));
  return el;
}
function scene(file,alt){
  const img=html('img','','scene');
  img.src=asset(file);
  img.alt=alt;
  return img;
}
function backdrop(node){
  return node.art.endsWith('.png')?node.art:'wood-'+node.art+'-v1.png';
}
function battleBackdrop(node){
  return node.type==='boss' ? backdrop(node) : 'expedition-scenes-v2/battle-'+regionOf(node).id+'.webp';
}
async function expeditionApi(path,body){
  const response=await fetch('/api/runs/'+encodeURIComponent(expeditionId)+path,body===undefined?{cache:'no-store'}:{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  });
  const data=await response.json();
  if(!response.ok)throw new Error(data.error ?? 'EXPEDITION_UNAVAILABLE');
  return data;
}
async function submitExpedition(intent){
  const signature=JSON.stringify(intent);
  if(pendingRemoteAction && pendingRemoteAction.signature!==signature){
    $('announcement').textContent='Retry your last action or reopen this expedition.';
    return null;
  }
  pendingRemoteAction??={signature,body:{intent,expectedVersion:remoteRun.version,operationId:crypto.randomUUID()}};
  busy=true;
  $('expedition-error').hidden=true;
  $('announcement').textContent='';
  try{
    remoteRun=await expeditionApi('/actions',pendingRemoteAction.body);
    pendingRemoteAction=undefined;
    state=remoteRun.state;
    return remoteRun.action ?? true;
  }catch(error){
    if(['STALE_VERSION','RUN_CLOSED'].includes(error.message)){
      try{
        remoteRun=await expeditionApi('');
        state=remoteRun.state;
        selection=null;
        pendingRemoteAction=undefined;
      }catch{}
    }
    if(error.message==='INVALID_ACTION')pendingRemoteAction=undefined;
    return null;
  }finally{busy=false;}
}
function showExpeditionError(message){
  const banner=$('expedition-error');
  banner.textContent=message;
  banner.hidden=false;
}
async function update(operation,intent,beforeRender){
  if(expeditionId&&busy)return;
  const wasInBattle=state.phase==='battle';
  if(expeditionId){
    if(!intent)return;
    if(!await submitExpedition(intent)){
      render();
      showExpeditionError('Action could not be confirmed. Retry or reopen Expedition Kit.');
      return;
    }
  }else if(!operation())return;
  selection=null;
  save();
  if(wasInBattle&&(state.phase==='reward'||state.phase==='defeat')){
    void showBattleOutcome();
    return;
  }
  if(beforeRender)await beforeRender();
  render();
}
function collectReward(kind,recipient,skill,control,recipientAvatar){
  if(busy)return;
  const target=kind==='equipment'
    ? document.querySelector('#loot-diary .loot-slots')?.children[state.pack.equipment.length]
    : kind==='token' ? $('loot-token-slot')
    : kind==='copper' ? $('loot-reward-purse')
    : kind==='instant' ? recipientAvatar
    : kind==='remedy' ? document.querySelector('#satchel-menu > summary')
    : null;
  const motion=prepareLootMotion(control,target);
  void update(()=>claim(state,kind,recipient,skill),{type:'claim',choice:kind,heroKey:recipient,skill},
    ()=>playLootMotion(motion));
}

function ask(title,copy,callback){
  $('confirm-title').textContent=title;
  $('confirm-copy').textContent=copy;
  onConfirm=callback;
  $('confirmation').returnValue='cancel';
  $('confirmation').showModal();
}
$('confirmation').onclose=()=>{
  if($('confirmation').returnValue==='confirm')onConfirm?.();
  onConfirm=null;
};
$('restart').onclick=()=>journey.selectStarter(false);

const routeTypes={
  story:'Main story',battle:'Battle',coin:'Copper battle',crossing:'Crossing',hidden:'Hidden encounter',
  merchant:'Merchant',elite:'Elite battle',camp:'Recovery',supply:'Supply cache',boss:'Regional boss',
};
const routeKind=node=>node.id==='trainer'?'Trainer':routeTypes[node.type];
function routeBadge(node,unknown){
  const frameType=unknown?'unseen':
    ['story','hidden','crossing'].includes(node.type)?'scroll':
    node.type==='supply'?'coin':node.type;
  const badge=html('span','','route-badge');
  badge.dataset.frame=frameType;
  let icon;
  if(unknown||node.type==='hidden')icon=html('span','?','route-glyph');
  else if(node.type==='story')icon=html('span','!','route-glyph');
  else if(node.type==='coin')icon=html('span','◉','route-glyph');
  else if(node.type==='camp'&&node.id!=='trainer')icon=html('span','✚','route-glyph heal');
  else icon=routeIcon(nodeTypes[node.type][1]);
  badge.append(icon);
  badge.setAttribute('aria-hidden','true');
  return badge;
}
function routePath(from,to){
  const x1=from.x*10,y1=from.y*10,x2=to.x*10,y2=to.y*10;
  const bend=(x2-x1)*.38;
  return `M ${x1} ${y1} C ${x1+bend} ${y1}, ${x2-bend} ${y2}, ${x2} ${y2}`;
}
async function travelRoute(id){
  if(busy||!routeChoices().includes(id))return;
  cue('route');
  if(reduced()){update(()=>enter(state,id),{type:'enter',node:id});return;}
  const path=$('roads').querySelector('[data-to="'+id+'"].reachable');
  if(!path){update(()=>enter(state,id),{type:'enter',node:id});return;}
  busy=true;
  for(const node of $('nodes').querySelectorAll('button'))node.disabled=true;
  $('route-readout').textContent='Traveling to '+map[id].name+'…';
  path.classList.add('traveling');
  const length=path.getTotalLength();
  const {width,height}=$('route-plot').getBoundingClientRect();
  const start=path.getPointAtLength(0);
  let distance=0, previous=start;
  const frames=Array.from({length:25},(_,index)=>{
    const point=path.getPointAtLength(length*index/24);
    distance+=Math.hypot((point.x-previous.x)*width/1000,(point.y-previous.y)*height/1000);
    previous=point;
    return {transform:`translate(calc(-50% + ${(point.x-start.x)*width/1000}px), calc(-50% + ${(point.y-start.y)*height/1000}px))`};
  });
  try{
    const duration=Math.max(260,Math.min(1250,distance*4));
    const motion=$('route-marker').animate(frames,{duration,easing:'linear',fill:'forwards'});
    await motion.finished.catch(()=>{});
  }finally{
    busy=false;
    update(()=>enter(state,id),{type:'enter',node:id});
  }
}
function renderMap(){
  const next=routeChoices();
  const region=regionOf(currentNode(state));
  $('map').style.setProperty('--route-landscape','url("'+asset('expedition-scenes-v2/route-'+region.id+'.webp')+'")');
  $('route-emblem').src=asset('region-emblems-v2/'+region.id+'.png');
  $('route-region').textContent=region.name;
  $('route-chapter').textContent='Region '+region.number+' of '+regions.length;
  $('route-scroll').setAttribute('aria-label',region.name+' route map');
  const lines=[];
  const icons=[];
  const svgNS='http://www.w3.org/2000/svg';
  for(const node of nodes){
    if(regionOf(node)!==region)continue;
    for(const id of (remoteRun&&node.id===state.node?next:node.next)){
      const child=map[id],line=document.createElementNS(svgNS,'path');
      line.setAttribute('d',routePath(node,child));
      line.dataset.to=id;
      if(node.id===state.node&&next.includes(id))line.classList.add('reachable');
      if(state.visited[state.visited.indexOf(node.id)+1]===id&&state.visited.includes(node.id))line.classList.add('taken');
      lines.push(line);
    }
    const reachable=next.includes(node.id),current=state.node===node.id;
    const passed=state.visited.includes(node.id);
    const scouted=state.trial>=11;
    const unknown=!scouted&&!passed&&!current&&!reachable&&node.type!=='boss';
    const el=button('',()=>void travelRoute(node.id),{className:'node '+(unknown?'unseen':node.type)+(reachable?' reachable':'')+
      (current?' current':'')+(passed?' passed':'')+(scouted?' scouted':''),disabled:!reachable});
    const status=reachable?'Available':current?'Current location':passed?'Visited':'Unavailable';
    el.title=(unknown?'Undiscovered stop':node.name+' · '+routeKind(node))+' · '+status;
    if(unknown)el.dataset.unknown='';
    el.dataset.node=node.id;
    el.setAttribute('aria-label',el.title);
    if(current)el.setAttribute('aria-current','location');
    el.style.left=node.x+'%';el.style.top=node.y+'%';
    el.append(routeBadge(node,unknown),html('span',unknown?'':node.name,'node-label'));
    if(reachable){
      const show=()=>$('route-readout').textContent=node.name+' · '+routeKind(node);
      const reset=()=>$('route-readout').textContent=map[state.node].name+' · Choose the next stop';
      el.onpointerenter=el.onfocus=show;
      el.onpointerleave=el.onblur=()=>{if(!busy)reset();};
    }
    icons.push(el);
  }
  $('roads').replaceChildren(...lines);
  $('nodes').replaceChildren(...icons);
  const current=map[state.node];
  const marker=$('route-marker');
  for(const animation of marker.getAnimations())animation.cancel();
  marker.style.left=current.x+'%';
  marker.style.top=current.y+'%';
  const lead=active(state.heroes)[0]??state.heroes[0];
  const portrait=html('img');
  portrait.src=asset('warden-avatars-v1/'+lead.id+'.png');
  portrait.alt='';
  marker.replaceChildren(portrait);
  $('route-readout').textContent=current.name+' · Choose the next stop';
}

for(const [type,label] of Object.entries(routeTypes)){
  const item=html('span');
  item.append(routeBadge({type},false),document.createTextNode(label));
  $('legend').append(item);
}

function renderLoadout(parent){
  const details=html('details','','loadout');
  details.append(html('summary','Prepare technique faces'));
  const roster=html('label','Traveling reserve');
  const reserve=html('select');
  for(const hero of state.heroes)reserve.add(new Option(hero.name,hero.key));
  reserve.value=state.benchKey;
  reserve.onchange=()=>{state.benchKey=reserve.value;save();};
  roster.append(reserve);details.append(roster);
  for(const hero of state.heroes){
    const definition=heroes.find(entry=>entry.id===hero.id);
    for(const [index,value] of hero.skills.entries()){
      const label=html('label',hero.name+' · Technique '+(index===0?'A':'B'));
      const select=html('select');
      for(const id of definition.skills){
        const option=new Option(actions[id].name,id);
        option.disabled=id===hero.skills[1-index];
        select.add(option);
      }
      select.value=value;
      select.onchange=()=>{
        if(configure(state,hero.id,index,select.value)){save();renderDecision();$('decision').querySelector('details').open=true;}
      };
      label.append(select);details.append(label);
    }
  }
  parent.append(details);
}

const lootDetails={
  shield:{name:'Bark Shield',type:'Equipment',effect:'On spawn · Grants Guard.',description:'Guard blocks the next attack against this warden.'},
  salve:{name:'Reed Salve',type:'Combat token',effect:'Restores 50% of Max HP.',description:'Use it in battle to heal a warden.'},
};
function lootIcon(item){
  const icon=html('span','','loot-icon loot-icon-'+item);
  icon.setAttribute('aria-hidden','true');
  if(item==='shield')paintDiceFace(icon,'rook','guard','party');
  return icon;
}
function itemIcon(item){
  const icon=html('span','','item-icon');
  icon.setAttribute('aria-hidden','true');
  icon.style.backgroundPosition=(item.icon%3)*50+'% '+Math.floor(item.icon/3)*50+'%';
  return icon;
}
const shopItemArt={
  'guard-token':[0,0],
  'resin-buckle':[1,0],
  'juniper-beads':[0,1],
  'purify-token':[1,1],
};
const remedyShopArt={
  'ashwater-phial':[0,0],
  'distilled-ashwater':[1,0],
  'severance-seal':[2,0],
  'witchsalt-ward':[0,1],
  'pilgrim-lantern':[1,1],
};
function shopItemIcon(item){
  const position=shopItemArt[item.id];
  const remedyPosition=remedyShopArt[item.id];
  let icon;
  if(remedyPosition){
    icon=html('span','','item-icon remedy-item-paint');
    const [column,row]=remedyPosition;
    icon.style.backgroundPosition=column*50+'% '+row*100+'%';
  }else if(item.id==='charm'){
    icon=html('img','','shop-item-cutout');
    icon.src=asset('wood-item-bramble-charm-v1.webp');
    icon.alt='';
  }else if(position){
    icon=html('span','','item-icon shop-item-paint');
    icon.style.backgroundPosition=position.map(coordinate=>coordinate*100+'%').join(' ');
  }else if(item.id==='salve'){
    icon=lootIcon('salve');
  }else if(Number.isInteger(item.icon)){
    icon=itemIcon(item);
  }else{
    return null;
  }
  return framedItemIcon(icon);
}
function framedItemIcon(icon){
  const frame=html('span','','shop-item-frame');
  frame.setAttribute('aria-hidden','true');
  frame.append(icon);
  return frame;
}
const itemCaption=item=>[item.trigger,item.tag,item.text].filter(Boolean).join(' · ');
function rewardButton(label,frame,callback,{disabled=false,caption}={}){
  const control=button('',callback,{className:'reward-item',disabled});
  const copy=html('span',label,'loot-item-copy');
  if(caption)copy.append(html('small',caption));
  control.append(frame,copy);
  return control;
}
function rewardEquipmentIcon(id){
  const item=equipment[id];
  const frame=shopItemIcon({...item,id});
  if(frame)return frame;
  const icon=html('span','','loot-icon');
  paintDiceFace(icon,'rook','curse','foe');
  return framedItemIcon(icon);
}
function lootRow(item,collected){
  const info=lootDetails[item];
  const row=button(info.name,event=>collectTutorialLoot(item,event.currentTarget),{disabled:collected,className:'loot-row'});
  row.id='loot-'+item;
  row.setAttribute('aria-label',collected?info.name+' · Collected':'Collect '+info.name);
  row.setAttribute('aria-describedby',row.id+'-details');
  row.replaceChildren(item==='shield'?rewardEquipmentIcon('bark-shield'):framedItemIcon(lootIcon(item)),html('span',info.name,'loot-item-copy'));
  if(collected)row.append(html('span','✓','loot-check'));
  const details=html('span','','loot-details');
  details.id=row.id+'-details';
  details.append(html('strong',info.name),html('small',info.type),html('b',info.effect),html('span',info.description));
  const entry=html('div','','loot-entry');
  entry.append(row,details);
  return entry;
}

function hasSpoils(offer){
  return Boolean(offer.copper||offer.token||offer.gear?.length||offer.instant||offer.remedy);
}

function isEmptyBattleReward(){
  return state.phase==='reward'&&!hasTutorialLoot(state)
    && ['battle','coin'].includes(currentNode(state).type)
    && !hasSpoils(rewardOffer(state));
}

function renderLootDiary(tutorial, instant){
  const shieldInPouch=state.pack.equipment.includes('bark-shield');
  const diary=$('loot-diary');
  const purse=html('p','◉ '+state.copper,'loot-purse');
  purse.id='loot-reward-purse';
  purse.setAttribute('aria-label',state.copper+' Copper');
  const tokenStrip=html('div','','loot-tokens');tokenStrip.id='loot-token-slot';
  tokenStrip.setAttribute('aria-label','Combat tokens');
  for(const id of Object.keys(tokens))if(state.pack[id]){
    const face=html('span','','loot-die');
    paintDiceFace(face,'rook',id,'party');
    tokenStrip.append(face,html('span','× '+state.pack[id]));
  }
  const dice=html('div','','loot-dice');
  const partyDice=state.battle.dice.filter(die=>die.side==='party');
  for(const die of partyDice){
    const actor=dieActor(state,die);
    const icon=html('span','','loot-die');
    const face=actor?faceKey(die,actor):die.face;
    paintDiceFace(icon,face===SUMMON_FACE?companionForHero(actor):actor?.id,face,'party');
    dice.append(icon);
  }
  const slots=html('div','','loot-slots');
  for(let i=0;i<5;i++){
    const slot=html('span','','loot-slot');
    if(i===0&&tutorial){
      slot.id='loot-gear-slot';
      slot.setAttribute('aria-label',shieldInPouch?'Bark Shield':'Empty equipment slot');
      if(shieldInPouch)slot.append(lootIcon('shield'));
    }else if(state.pack.equipment[i])slot.append(itemIcon(equipment[state.pack.equipment[i]]));
    else slot.setAttribute('aria-hidden','true');
    slots.append(slot);
  }
  const roster=html('div','','loot-roster');roster.id='loot-roster';
  const lead=active(state.heroes)[0];
  for(const hero of state.heroes.filter(unit=>!unit.bench)){
    const card=html('article','','loot-warden');
    if(hero===lead)card.dataset.lead='true';
    const portrait=html('div','','loot-portrait');
    const avatar=html('span','','starter-avatar');
    const face=html('img');
    face.src=asset('warden-avatars-v1/'+hero.id+'.png');
    face.alt='';
    avatar.append(face);
    portrait.append(avatar,html('strong',hero.name),html('small','Lv. '+hero.level));
    const stats=html('div','','loot-warden-data');
    const attributes=html('div','','loot-stats');
    attributes.append(html('span','♥ '+hero.hp+'/'+hero.maxHp),html('span','⚔ '+hero.atk+' STR','loot-atk'));
    stats.append(attributes);
    if(tutorial&&shieldInPouch&&hero.hp&&hero.equipment.includes(null)&&!hasEquipment(hero,'bark-shield')){
      const equip=button('+',()=>update(()=>equipBarkShield(state,hero.key)),{className:'loot-slot'});
      equip.setAttribute('aria-label','Equip on '+hero.name);
      stats.append(equip);
    }else{
      const slot=html('span','','loot-slot');
      const equipped=hero.equipment.find(id=>equipment[id]);
      if(equipped){
        slot.setAttribute('aria-label',equipment[equipped].name+' equipped');
        slot.append(itemIcon(equipment[equipped]));
      }
      stats.append(slot);
    }
    card.append(portrait,stats);
    if(instant&&(hero.hp||instant==='umami-broth')){
      const choose=button('Choose',()=>{
        diary.classList.remove('choosing-recipient');
        collectReward('instant',hero.key,undefined,document.querySelector('.loot-instant'),avatar);
      },{className:'loot-recipient'});
      choose.setAttribute('aria-label','Use '+instantItems[instant].name+' on '+hero.name);
      card.append(choose);
    }
    roster.append(card);
  }
  const resources=html('div','','loot-resources');
  resources.append(purse,tokenStrip);
  diary.classList.remove('choosing-recipient');
  diary.replaceChildren(resources,html('h3','Dice'),dice,html('h3','Equipment'),slots,html('h3','Team'),roster);
  if(instant){
    const cancel=button('Cancel',()=>{
      diary.classList.remove('choosing-recipient');
      document.querySelector('.loot-instant')?.focus();
    },{className:'loot-recipient'});
    diary.append(cancel);
  }
}

function frameResult(panel){
  const action=panel.lastElementChild;
  action.classList.add('result-action');
  const content=html('div','','result-content');
  let item=panel.firstElementChild.nextElementSibling;
  while(item!==action){
    const next=item.nextElementSibling;
    content.append(item);
    item=next;
  }
  panel.insertBefore(content,action);
}

function renderDecision(){
  const node=currentNode(state),panel=$('decision');
  const titles={complete:'The Waymarks restored',defeat:'Expedition lost',reward:'Collect your loot'};
  const phase=state.phase;
  $('loot-diary').hidden=phase!=='reward';
  $('shopkeeper').hidden=true;
  delete document.body.dataset.vendor;
  panel.hidden=phase==='map';
  $('map').hidden=phase!=='map';
  const scenery=$('travel-scene');
  scenery.hidden=phase==='map'||hasTutorialLoot(state);
  if(phase==='map')return;
  const isMarket=node.id==='market',isWitch=node.vendor==='hester';
  let sceneArt=backdrop(node);
  if(phase==='reward')sceneArt=battleBackdrop(node);
  const vendor=phase==='shop'?(isWitch?'hester':isMarket?'merrin':'sable'):node.id==='trainer'?'orin':null;
  if(vendor){
    document.body.dataset.vendor=vendor;
    sceneArt='wood-stall-'+vendor+'-v1.webp';
    const portrait={merrin:'wood-npc-merrin-holt-v2.png',sable:'wood-npc-sable-fen-v2.png',orin:'wood-npc-orin-thatch-v2.png',hester:'wood-npc-hester-wren-v1.webp'}[vendor];
    if(portrait){
      const keeper=$('shopkeeper');
      keeper.src=asset(portrait);
      keeper.hidden=false;
    }
  }
  const sceneUrl=asset(sceneArt);
  if(scenery.getAttribute('src')!==sceneUrl)scenery.src=sceneUrl;
  const title=html('h2',titles[state.phase]??node.name);title.id='decision-title';
  panel.replaceChildren(title);
  if(phase==='reward')renderLootDiary(hasTutorialLoot(state),hasTutorialLoot(state)?null:rewardOffer(state).instant);
  if(state.phase==='complete'||state.phase==='defeat'){
    const receipt=expeditionId?null:journey?.recordProgress();
    panel.append(html('p',state.report),html('p',state.visited.length+' stops cleared · '+state.copper+' Copper · '+state.pack.seed+' Hollow Seed'));
    if(receipt){
      const difficulty=receipt.trial?trialLabel(receipt.trial)+' · ':'';
      panel.append(html('p',difficulty+'+'+receipt.xp+' Talisman XP · '+receipt.totalXp+' total'));
      for(const unlock of receipt.unlocked.filter(label=>!label.startsWith('Trial ')))panel.append(html('p','Unlocked · '+unlock));
    }
    panel.append(expeditionId
      ? button('Expedition Kit',()=>location.assign('/online-expedition.html'))
      : button('Play again',()=>journey.selectStarter(false)));
    frameResult(panel);
    return;
  }
  if(state.phase==='reward'){
    if(hasTutorialLoot(state)){
      title.textContent='Collect all your loot!';
      const loot=state.battle.tutorialLoot??{};
      const shieldInPouch=state.pack.equipment.includes('bark-shield');
      const salve=lootRow('salve',loot.salve);
      if(!loot.salve&&tokenCount(state)>=tokenCapacity){
        salve.querySelector('button').disabled=true;
        salve.querySelector('button').title='Token pouch is full.';
      }
      const shield=lootRow('shield',loot.shield);
      if(!loot.shield&&state.pack.equipment.length>=equipmentCapacity){
        shield.querySelector('button').disabled=true;
        shield.querySelector('button').title='Equipment pouch is full.';
      }
      panel.append(shield,salve,button(loot.shield&&loot.salve?'Continue':'Skip',()=>{
          if(loot.shield&&loot.salve)update(()=>tutorialLoot(state,'leave'));
          else ask('Leave loot behind?','Uncollected items will be left on the road.',()=>update(()=>tutorialLoot(state,'leave')));
        },{className:'loot-leave'}));
      frameResult(panel);
      return;
    }
    const offer=rewardOffer(state);
    if(!hasSpoils(offer)&&['battle','coin'].includes(node.type))title.textContent='Victory';
    panel.append(html('p',state.report));
    if(state.battle.copperEarned)panel.append(html('p','Earned '+state.battle.copperEarned+' Copper'));
    if(offer.remedy){
      const remedy=REMEDY_CATALOG[offer.remedy];
      panel.append(rewardButton('Collect '+remedy.name,shopItemIcon(remedy),event=>collectReward('remedy',undefined,undefined,event.currentTarget),
        {disabled:remedyCount(state)>=REMEDY_CAPACITY,caption:remedy.text}));
    }
    if(offer.copper){
      const coin=html('img','','reward-coin');
      coin.src=asset('account-v1/copper.png');
      coin.alt='';
      panel.append(rewardButton('Collect '+offer.copper+' Copper',framedItemIcon(coin),event=>collectReward('copper',undefined,undefined,event.currentTarget)));
    }
    if(offer.token){
      let frame=shopItemIcon({id:offer.token});
      if(!frame){
        const face=html('span','','loot-icon');
        paintDiceFace(face,'rook',offer.token,'party');
        frame=framedItemIcon(face);
      }
      const full=tokenCount(state)>=tokenCapacity;
      panel.append(rewardButton('Collect '+tokens[offer.token].name,frame,event=>collectReward('token',undefined,undefined,event.currentTarget),{
        disabled:full,
        caption:full?'Token pouch is full.':tokens[offer.token].effect,
      }));
    }
    if(offer.gear?.length){
      const full=state.pack.equipment.length>=equipmentCapacity;
      panel.append(html('p',full?'Equipment pouch is full. Open the Travel Diary to make room.':
        offer.gear.length>1?'Choose one piece of equipment.':'Equipment'));
      for(const id of offer.gear)panel.append(rewardButton('Take '+equipment[id].name,rewardEquipmentIcon(id),event=>collectReward('equipment',id,undefined,event.currentTarget),
        {disabled:full,caption:itemCaption(equipment[id])}));
    }
    if(offer.instant){
      const item=instantItems[offer.instant];
      const canUse=state.heroes.some(hero=>!hero.bench&&(hero.hp||offer.instant==='umami-broth'));
      const control=rewardButton('Use '+item.name,framedItemIcon(itemIcon(item)),()=>{
        const diary=$('loot-diary');
        diary.classList.add('choosing-recipient');
        diary.querySelector('.loot-recipient')?.focus();
      },{disabled:!canUse,caption:itemCaption(item)});
      control.classList.add('loot-instant');
      panel.append(control);
    }
    const options=state.heroes.flatMap(hero=>hero.skills.filter(key=>canEngrave(hero,key)).map(key=>[hero,key]));
    if(node.type==='elite'&&!state.battle.engravingClaimed&&options.length){
      const label=html('label','Engraving · +25% power this run','engrave');
      const select=html('select');
      select.setAttribute('aria-label','Technique to engrave');
      for(const [index,[hero,key]] of options.entries())select.add(new Option(hero.name.split(' ')[0]+' · '+actions[key].name,index));
      label.append(select);
      panel.append(label,button('Engrave the technique',()=>{
        const [hero,key]=options[Number(select.value)];
        collectReward('engrave',hero.key,key);
      },{className:'secondary'}));
    }
    const pending=hasSpoils(offer);
    const onward=node.type==='boss'?nextRegion(state):null;
    const leaveLabel=onward?'Travel to '+onward.name:node.type==='boss'?'Finish expedition':'Continue';
    if(onward)panel.append(html('p','Waymark blessing · All wardens gain a level, +3 STR, +2 INT, and +8 Max HP.'));
    panel.append(button(pending&&node.type!=='boss'?'Skip':leaveLabel,()=>{
      const leave=()=>update(()=>claim(state,'leave'),{type:'claim',choice:'leave'});
      if(pending)ask('Leave loot behind?','Uncollected loot stays here.',leave);
      else leave();
    }));
    frameResult(panel);
    return;
  }
  if(state.phase==='shop'){
    panel.append(html('p',isWitch?'Hester Wren':isMarket?'Merrin Holt':'Sable Fen'));
    const purse=html('p',state.copper+' Copper','shop-purse');
    const coin=html('img');
    coin.src=asset('account-v1/copper.png');coin.alt='';
    purse.prepend(coin);
    const goods=shopInventory(state);
    const stock=html('div','','shop-shelf');
    const shelves=Array.from({length:isMarket?2:1},()=>html('div','','shop-board'));
    const itemGrid=!isMarket?html('div','','shop-item-grid'):null;
    if(itemGrid)shelves[0].append(itemGrid);
    stock.append(...shelves);
    panel.append(purse,stock);
    for(const [index,item] of goods.entries()){
      const sold=Boolean(state.bought[node.id+':'+item.id])||item.remaining===0;
      const full=Boolean(tokens[item.id])&&tokenCount(state)>=tokenCapacity;
      const gearFull=Boolean(equipment[item.id])&&state.pack.equipment.length>=equipmentCapacity;
      const reason=sold?'Sold out.':full?'Combat token pouch is full.':gearFull?'Equipment pouch is full.':item.stockReason;
      const row=html('article','','shop-goods');
      const title=html('strong',item.name+(item.remaining>0?' · '+item.remaining+' left':''));
      const icon=shopItemIcon(item);
      if(icon)row.append(icon);
      const details=html('div','','shop-item-details');
      const description=reason||item.text||tokens[item.id]?.effect||'';
      details.append(title,html('small',description));
      row.title=description||item.name;
      const pay=button(item.price+' Copper',()=>update(()=>buy(state,item.id),{type:'buy',itemId:item.id}),
        {disabled:Boolean(reason)||!canAffordCopper(state,item.price),className:'secondary'});
      pay.setAttribute('aria-label','Buy '+item.name+' for '+item.price+' Copper');
      details.append(pay);
      row.append(details);
      (itemGrid??shelves[isMarket&&index>=Math.ceil(goods.length/2)?1:0]).append(row);
    }
    if(itemGrid){
      for(let index=goods.length;index<6;index++){
        const empty=html('div','','shop-goods shop-goods-empty');
        empty.setAttribute('aria-hidden','true');
        empty.append(html('span','','shop-item-frame'));
        const details=html('div','','shop-item-details');
        details.append(html('strong',''),html('span','–','shop-empty-price'));
        empty.append(details);
        itemGrid.append(empty);
      }
    }
    if(isWitch)renderOwnedRemedies(panel,{collapsible:true});
    panel.append(button('Leave the stall',()=>update(()=>leaveShop(state),{type:'leave-shop'}),{className:'secondary'}));
    return;
  }
  if(node.id==='trainer'){
    const wardens=active(state.heroes);
    let pupil=wardens[0];
    const roster=html('div','','mentor-wardens');
    roster.setAttribute('role','group');
    roster.setAttribute('aria-label','Warden to train');
    for(const hero of wardens){
      const card=html('div','','mentor-warden');
      const choice=button('',()=>{
        pupil=hero;
        for(const control of roster.querySelectorAll('button'))control.setAttribute('aria-pressed',String(control===choice));
      },{className:'mentor-portrait'});
      const portrait=html('span','','starter-avatar');
      const face=html('img');
      face.src=asset('warden-avatars-v1/'+hero.id+'.png');
      face.alt='';
      portrait.append(face);
      choice.append(portrait);
      choice.setAttribute('aria-label',hero.name+' · Level '+hero.level);
      choice.setAttribute('aria-pressed',String(hero===pupil));
      card.append(choice,html('span',hero.name,'mentor-warden-name'));
      roster.append(card);
    }
    const board=html('div','','mentor-lessons');
    const lessons=html('div','','mentor-controls');
    lessons.append(roster);
    board.append(lessons);
    panel.append(board);
    for(const [key,lesson] of Object.entries(training)){
      lessons.append(button(lesson.label,()=>{
        if(!pupil)return;
        const heroKey=pupil.key;
        update(()=>visitTrainer(state,key,heroKey),{type:'trainer',choice:key,heroKey});
      },{disabled:!pupil}));
    }
    lessons.append(button('Revive and heal party',()=>update(()=>visitTrainer(state,'rest'),{type:'trainer',choice:'rest'})));
    panel.append(button('Leave',()=>update(()=>visitTrainer(state,'leave'),{type:'trainer',choice:'leave'}),{className:'secondary'}));
    return;
  }
  const event=story[state.node];
  panel.append(html('p',event.copy));
  if(node.id==='threshold'&&!expeditionId)renderLoadout(panel);
  if(node.id==='threshold'&&expeditionId)panel.append(button('Expedition Kit',()=>location.assign('/online-expedition.html'),{className:'secondary'}));
  if(expeditionId && event.choices.some(([key])=>key==='bargain')){
    for(const hero of active(state.heroes))for(const curseId of ['withered','brittle','blood-debt']){
      panel.append(button(hero.name+' · '+CURSE_DEFINITIONS[curseId].name,()=>update(
        ()=>chooseEvent(state,'bargain',hero.key,curseId),{type:'event',choice:'bargain',heroKey:hero.key,curseId}
      ),{className:'choice'}));
    }
  }
  for(const [key,label,caption] of event.choices){
    if(expeditionId&&key==='bargain')continue;
    panel.append(button(label,()=>update(()=>chooseEvent(state,key),{type:'event',choice:key}),{className:'choice',caption,
      disabled:key==='toll'&&state.copper<8||key==='revive'&&living(state.heroes).length===state.heroes.length}));
  }
}

function prepareLootMotion(control,target){
  const frame=control?.querySelector('.shop-item-frame');
  if(!frame||!target||reduced())return null;
  return {control,frame,target};
}

async function playLootMotion(motion){
  if(!motion){cue('loot');return;}
  const {control,frame,target}=motion;
  const from=frame.getBoundingClientRect();
  const to=target.getBoundingClientRect();
  const dx=to.x+to.width/2-from.x-from.width/2;
  const dy=to.y+to.height/2-from.y-from.height/2;
  const token=frame.cloneNode(true);
  const pulse=html('span','','loot-receive');
  token.classList.add('loot-transfer');
  Object.assign(token.style,{width:from.width+'px',left:from.x+from.width/2+'px',top:from.y+from.height/2+'px'});
  Object.assign(pulse.style,{width:Math.min(to.width,to.height)+'px',left:to.x+to.width/2+'px',top:to.y+to.height/2+'px'});
  pulse.setAttribute('aria-hidden','true');
  const decision=$('decision'), diary=$('loot-diary');
  decision.inert=true;diary.inert=true;busy=true;
  document.body.append(token);
  control.animate([{opacity:1},{opacity:.35}],{duration:150,fill:'forwards'});
  try{
    await token.animate([
      {transform:'translate(-50%,-50%) scale(1)',opacity:1},
      {transform:`translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.6)`,opacity:1},
    ],{duration:160,easing:beats.settleEase,fill:'forwards'}).finished;
    token.remove();
    cue('loot');
    document.body.append(pulse);
    await pulse.animate([
      {transform:'translate(-50%,-50%) scale(.7)',opacity:1},
      {transform:'translate(-50%,-50%) scale(1.7)',opacity:0},
    ],{duration:230,easing:'ease-out'}).finished;
  }catch{
    // The reward is already recorded if presentation is interrupted.
  }finally{
    token.remove();pulse.remove();decision.inert=false;diary.inert=false;busy=false;
  }
}

async function collectTutorialLoot(item,control){
  if(busy)return;
  const target=$(item==='shield'?'loot-gear-slot':'loot-token-slot');
  const motion=prepareLootMotion(control,target);
  if(!tutorialLoot(state,item))return;
  save();
  await playLootMotion(motion);
  render();
}

function renderOwnedRemedies(parent,{collapsible=false}={}){
  const owned=Object.entries(REMEDY_CATALOG).filter(([id])=>state.pack.remedies?.[id]>0);
  if(!owned.length)return;
  const section=html(collapsible?'details':'section','','owned-remedies');
  section.append(html(collapsible?'summary':'strong','Remedies · '+remedyCount(state)+' / '+REMEDY_CAPACITY));
  for(const [id,item] of owned){
    const select=html('select');
    select.setAttribute('aria-label','Target for '+item.name);
    const targets=[];
    for(const hero of state.heroes){
      const options=item.reduction?Object.keys(CURSE_DEFINITIONS).map(curseId=>({curseId})):
        id==='severance-seal'?hero.equipment.map((_,slot)=>({slot})):[{}];
      for(const option of options){
        if(!previewRemedy(state,id,hero.key,option).ok)continue;
        const detail=option.curseId?CURSE_DEFINITIONS[option.curseId].name:
          option.slot!==undefined?equipment[hero.equipment[option.slot]].name:'';
        select.add(new Option(hero.name+(detail?' · '+detail:''),String(targets.length)));
        targets.push({heroKey:hero.key,option,detail});
      }
    }
    const row=html('article','','shop-goods');
    row.append(html('strong',item.name+' ×'+state.pack.remedies[id]));
    row.append(html('small',targets.length?item.text:'No eligible target. '+item.text));
    if(targets.length)row.append(select,button('Use '+item.name,()=>{
      const {heroKey,option,detail}=targets[Number(select.value)];
      const apply=()=>update(()=>{
        if(!useRemedy(state,id,heroKey,option).ok)return false;
        state.report=item.name+' used on '+state.heroes.find(hero=>hero.key===heroKey).name+'.';
        return true;
      },{type:'use-remedy',itemId:id,heroKey,...option});
      if(id==='severance-seal')ask('Destroy '+detail+'?',item.text,apply);
      else apply();
    },{className:'secondary'}));
    section.append(row);
  }
  parent.append(section);
}

function renderParty(){
  const manageable=['map','reward','event','shop'].includes(state.phase);
  const pouch=$('equipment-pouch');
  const inventory=state.pack.equipment;
  const tiles=html('div','','equipment-tiles');
  for(let index=0;index<equipmentCapacity;index++){
    const item=equipment[inventory[index]];
    if(!item){tiles.append(html('span','','equipment-tile'));continue;}
    const tile=html('div','','equipment-tile');
    tile.title=item.name+' · '+itemCaption(item);
    tile.append(itemIcon(item));
    if(manageable){
      const discard=button('×',()=>ask('Discard '+item.name+'?','This equipment will be lost for the rest of the run.',()=>{
        update(()=>discardEquipment(state,index),{type:'discard-equipment',index});
      }),{className:'discard-item'});
      discard.setAttribute('aria-label','Discard '+item.name);
      tile.append(discard);
    }
    tiles.append(tile);
  }
  pouch.replaceChildren(html('strong','Equipment pouch · '+inventory.length+' / '+equipmentCapacity),tiles);
  if(manageable)renderOwnedRemedies(pouch);
  $('party-panel').replaceChildren(...state.heroes.map((hero,index)=>{
    const card=html('article','',hero.hp?'hero-card':'hero-card fallen');
    const hp=html('progress');
    hp.max=hero.maxHp;hp.value=hero.hp;
    hp.setAttribute('aria-label',hero.name+' health');
    const fighting=state.phase==='battle';
    const strength=hero.atk+(fighting?(hero.boost??0):0);
    const stats=hero.hp+' / '+hero.maxHp+' HP · '+strength+' STR · '+hero.int+' INT';
    card.append(html('strong',hero.name+' · Lv. '+hero.level),hp,html('small',stats+(fighting?' · '+hero.ward+' Defense':'')),
      html('small',hero.hp?(hero.bench?'Traveling reserve':fighting&&state.battle.lead&&active(state.heroes)[0]===hero?'Lead':'Slot '+(index+1))+' · '+[heroes.find(entry=>entry.id===hero.id).role,
        fighting&&hero.guard?'Guard':null,fighting&&hero.rooted?'Rooted':null,fighting&&hero.bleed?'Bleed':null].filter(Boolean).join(' · '):'Downed'));
    const spirit=companions[companionForHero(hero)];
    if(spirit){
      const bond=html('details','','companion-bond');
      bond.append(html('summary',spirit.name+' · '+spirit.element),
        html('small',spirit.hp+' Spirit HP · '+spirit.str+' STR · '+spirit.int+' INT · '+spirit.def+' Defense'),
        html('small',spirit.skill+' · '+spirit.text));
      card.append(bond);
    }
    if(hero.hp&&hero.hp<hero.maxHp&&state.pack.salve&&['map','shop','event'].includes(state.phase))
      card.append(button('Use Reed Salve',()=>update(()=>fieldSalve(state,hero.key),{type:'salve',heroKey:hero.key}),{className:'secondary'}));
    for(const [slot,id] of hero.equipment.entries()){
      const item=equipment[id];
      const row=html('div','','warden-equipment');
      if(item)row.append(itemIcon(item));
      const label=html('span',item?item.name:'Empty slot '+(slot+1));
      label.title=item?itemCaption(item):'';
      row.append(label);
      if(manageable&&item?.tag!=='Cursed'){
        const picker=html('select');
        picker.setAttribute('aria-label',hero.name+' equipment slot '+(slot+1));
        picker.add(new Option(item?'Manage item':'Equip item',''));
        if(item&&inventory.length<equipmentCapacity)picker.add(new Option('Return to pouch','remove'));
        for(const [index,key] of inventory.entries()){
          if(!hasEquipment(hero,key))picker.add(new Option(equipment[key].name,String(index)));
        }
        if(picker.options.length>1){
          picker.onchange=()=>{
            if(!picker.value)return;
            const selected=picker.value==='remove'?null:Number(picker.value);
            const apply=()=>update(()=>moveEquipment(state,hero.key,slot,selected,{confirmed:true}),{type:'move-equipment',heroKey:hero.key,slot,index:selected,confirmed:true});
            if(selected!==null&&equipment[inventory[selected]].tag==='Cursed'){
              ask('Equip '+equipment[inventory[selected]].name+'?','This item locks its slot until destroyed with a Severance Seal.',apply);
              picker.value='';
            }else apply();
          };
          row.append(picker);
        }
      }else if(item?.tag==='Cursed')row.append(html('small','Locked'));
      card.append(row);
    }
    return card;
  }));
}

function useDie(die,plan,event){
  if(busy||!plan||(state.battle.lead&&plan.reason))return;
  if(selection?.id===die.id&&!selection.brace){
    selection=null;
  }else{
    selection={id:die.id};
    if(!plan.reason&&!plan.choose&&(plan.random||plan.enemy||plan.targets.length===1)){
      selection.target=plan.targets[0]?.key;
      void play();
      return;
    }
  }
  renderCombat();
  const firstChoice=event.detail===0&&selection&&state.battle.lead?
    document.querySelector('#target-layer button,.rotation-choices button'):null;
  (firstChoice??document.getElementById('die-'+die.id))?.focus({preventScroll:true});
}

const dieStatusNotes={
  guard:['Guard','Blocks the next Attack and is then consumed. Direct damage can bypass Guard.'],
  ward:['Personal Defense','After Squad Defense, absorbs Attack damage before HP. Each point is spent when it absorbs damage.'],
  root:['Rooted','Prevents formation movement while active.'],
  bleed:['Bleed','Deals direct damage equal to its value when the affected unit’s team rotates.'],
  mark:['Marked','Attacks against a marked unit deal 4 extra damage.'],
};
const dieActionLabels={hit:'Attack',pull:'Attack · Movement',guard:'Defense',ward:'Defense',heal:'Recovery',
  rotate:'Rotation',shift:'Rotation',mark:'Debuff',cleanse:'Cleanse',boost:'Buff',cover:'Protection',idle:'Pass'};
const dieRotationNames={rotate:'Free Rotation','rotate-left':'Rotate Left','rotate-right':'Rotate Right','rotate-random':'Random Rotation'};
function dieHint(die,actor,key,name,action,plan,faces){
  const enemy=die.side==='foe';
  const hint=html('span','','paper-popover die-hint');
  const header=html('span','','die-hint-header');
  const title=html('span','','die-hint-title');
  const preview=skillPreview(actor.id,key,die.side);
  if(preview)header.append(preview);
  title.append(html('strong',name),html('small',(dieActionLabels[action.type]??'Action')+' · '+actor.name));
  header.append(title);
  hint.append(header);

  const copy=action.text?.trim()??'';
  const summary=key==='idle'?'Use this die without taking an action.':
    dieRotationNames[key]?'Rotate the team to change its lead.':
    action.type==='ward'?'Give '+action.amount+' personal Defense to the target.':
    action.type==='guard'?'Gain Guard.':
    action.root?'Attack the target and apply Rooted.':
    action.bleed?'Attack the target and apply Bleed.':
    action.type==='hit'?'Attack the indicated target.':
    action.type==='pull'?'Attack and pull the target out of position.':'Resolve the displayed action.';
  const text=!copy||copy.startsWith('Power:')?[summary,copy].filter(Boolean).join(' '):copy;
  hint.append(html('span',text,'die-hint-copy'));
  const details=[];
  if(plan?.reason)details.push(plan.reason);
  if(enemy&&plan?.targets.length&&!plan.choose)details.push('Target: '+plan.targets.map(unit=>unit.name).join(', '));
  if(isScriptedDie(die))details.push('Fixed during Reroll.');
  if(die.optional)details.push('Optional intent.');
  if(details.length)hint.append(html('small',details.join(' · '),'die-hint-detail'));

  const section=html('span','','die-hint-faces');
  section.append(html('small','Die faces','die-hint-kicker'));
  const row=html('span','','die-hint-face-row');
  // The teaching round and boss telegraphs can override the rolled face.
  // The row always shows the configured pool in its original order.
  for(const face of faces){
    const resolved=faceKey(die,actor,face);
    const tile=html('span','','die-hint-face');
    tile.dataset.current=String(face===die.face);
    tile.title=resolved===SUMMON_FACE?'Summon '+(companions[companionForHero(actor)]?.name??'Companion'):dieRotationNames[resolved]??(enemy?intent:actions)[resolved]?.name??(resolved==='idle'?'Wait':resolved==='bulk-up'?'Bulk Up':resolved==='ranged'?'Range Attack':'Action');
    paintDiceFace(tile,resolved===SUMMON_FACE?companionForHero(actor):actor.id,resolved,die.side);
    row.append(tile);
  }
  section.append(row);
  if(!faces.includes(die.face))section.append(html('small',die.curse?'Curse roll':'This roll was preset.','die-hint-detail'));
  hint.append(section);

  const statuses=new Set([action.type,...['root','bleed','mark'].filter(status=>action[status])]);
  const glossary=[...statuses].map(status=>dieStatusNotes[status]).filter(Boolean);
  if(glossary.length){
    const notes=html('span','','die-hint-notes');
    for(const [label,description] of glossary){
      const note=html('span');
      note.append(html('b',label+' · '),document.createTextNode(description));
      notes.append(note);
    }
    hint.append(notes);
  }
  hint.setAttribute('aria-hidden','true');
  return {hint,description:[text,...details,...glossary.map(([label,copy])=>label+': '+copy)].join(' ')};
}

function attachDieHelp(die,hint,name){
  const slot=html('div','','die-slot '+(die.classList.contains('foe')?'foe':'party'));
  const help=button('',()=>setOpen(!slot.hasAttribute('data-help-open')),{className:'die-help',disabled:busy});
  help.append(html('span',name,'die-help-name'),html('span','?','die-help-mark'));
  hint.id=die.id+'-help';
  hint.setAttribute('role','tooltip');
  hint.hidden=true;
  help.setAttribute('aria-label','Inspect '+name);
  help.setAttribute('aria-controls',hint.id);
  help.setAttribute('aria-expanded','false');
  const setOpen=open=>{
    if(open){
      const rect=slot.getBoundingClientRect();
      const half=Math.min(155,(window.innerWidth-24)/2);
      const center=rect.left+rect.width/2;
      const clamped=Math.max(half+12,Math.min(window.innerWidth-half-12,center));
      hint.style.setProperty('--hint-offset',(clamped-center)+'px');
    }
    slot.toggleAttribute('data-help-open',open);
    hint.hidden=!open;
    hint.setAttribute('aria-hidden',String(!open));
    help.setAttribute('aria-expanded',String(open));
  };
  help.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch'&&!help.disabled)setOpen(true);});
  help.addEventListener('pointerleave',()=>{if(!help.matches(':focus-visible'))setOpen(false);});
  help.addEventListener('focus',()=>{if(help.matches(':focus-visible'))setOpen(true);});
  help.addEventListener('blur',()=>setOpen(false));
  help.addEventListener('click',event=>{if(event.pointerType==='mouse')setOpen(true);});
  slot.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||!slot.hasAttribute('data-help-open'))return;
    event.stopPropagation();
    setOpen(false);
    die.focus({preventScroll:true});
  });
  slot.append(die,help,hint);
  return slot;
}

function renderDie(die,index){
  const enemy=die.side==='foe';
  const team=enemy?state.battle.enemies:state.heroes;
  const actor=team.find(unit=>unit.key===die.resolvedActor)??dieActor(state,die)??team[0];
  const plan=describe(state,die.id);
  const key=die.resolvedKey??faceKey(die,actor);
  const action=plan?.action??(enemy?intent:actions)[key]??{};
  const name=key==='ranged'?'Range Attack':plan?.name??action.name??(key.startsWith('rotate')?'Rotation':'Wait');
  const el=button('',event=>useDie(die,plan,event),
    {className:'die '+die.side+(die.spent?' spent':''),disabled:busy||die.spent||!plan});
  el.id='die-'+die.id;
  el.dataset.state=die.cancelled?'cancelled':die.spent?'spent':rollingDice?.has(die.id)?'rolling':plan?.reason?'blocked':'ready';
  if(isScriptedDie(die))el.classList.add('scripted');
  el.setAttribute('aria-pressed',String(selection?.id===die.id));
  el.setAttribute('aria-label',actor.name+' · '+name+(die.spent?' · '+(die.cancelled?'Cancelled':'Spent'):''));
  const faces=dieFaces(state,die);
  const {hint,description}=dieHint(die,actor,key,name,action,plan,faces);
  el.setAttribute('aria-description',description);
  if(plan&&!plan.reason){
    const preview=()=>{
      if(busy||selection)return;
      const targets=!plan.random&&((enemy&&!plan.choose)||plan.targets.length===1)?plan.targets.map(unit=>unit.key):[];
      arena.preview(actor.key,targets);
    };
    const clear=()=>{if(!busy&&!selection)arena.clearPreview();};
    el.onpointerenter=el.onfocus=preview;
    el.onpointerleave=el.onblur=clear;
  }
  el.addEventListener('pointerenter',()=>diceVfx.highlight(el,true));
  el.addEventListener('pointerleave',()=>diceVfx.highlight(el,el.matches(':focus-visible')));
  el.addEventListener('focus',()=>{if(el.matches(':focus-visible'))diceVfx.highlight(el,true);});
  el.addEventListener('blur',()=>diceVfx.highlight(el,el.matches(':hover')));
  const cube=html('span','','cube');
  const order=displayFaces(die.face,faces);
  for(const [i,rolled] of order.entries()){
    const face=html('span','','face face-'+i);
    const resolved=i===0?key:faceKey(die,actor,rolled);
    paintDiceFace(face,resolved===SUMMON_FACE?companionForHero(actor):actor.id,resolved,die.side);
    cube.append(face);
  }
  const space=html('span','','cube-space');
  space.setAttribute('aria-hidden','true');space.append(cube);
  if(rollingDice?.has(die.id)){
    space.classList.add('rolling');
    const burst=html('span','','dice-roll-burst');
    for(let i=0;i<5;i++)burst.append(html('i'));
    space.append(burst);
  }
  if(!die.shared){
    const owner=html('small',actor.name[0],'die-owner');
    owner.setAttribute('aria-hidden','true');
    el.append(owner);
  }
  el.append(space);
  return attachDieHelp(el,hint,name);
}

function renderCombat(){
  const battle=state.battle;
  const node=currentNode(state);
  const pet=battle.companion;
  const summons=$('companion-status');
  summons.hidden=node.id==='road'&&(state.tutorial?.enabled||state.tutorial?.videoVersion===1);
  summons.textContent=pet
    ?companions[pet.id].name+' · '+(pet.expiresAfter-battle.round+1)+' left · '+pet.hp+' HP + '+pet.defense+' DEF'
    :'Summons '+(battle.summonCount??0)+' / '+SUMMON_LIMIT;
  $('battle-title').textContent=node.name;
  $('battle-meta').textContent=(state.trial?trialLabel(state.trial)+' · ':'')+'Round '+battle.round;
  if(battle.lead)$('battle-meta').textContent+=' · '+active(state.heroes)[0]?.name+' / '+active(battle.enemies)[0]?.name;
  if(battle.defense.party||battle.defense.foe)$('battle-meta').textContent+=
    ' · Squad Defense '+battle.defense.party+' / '+battle.defense.foe;
  const warning=battle.dice.find(die=>!die.spent&&isScriptedDie(die));
  $('boss-warning').hidden=!warning||Boolean(rollingDice);
  if(warning)$('boss-warning').textContent=warning.face==='siege'?'⚠ All wardens':'⚠ Front + rear';
  for(const [side,container] of [['party','party-dice'],['foe','enemy-dice']]){
    const dice=battle.dice.filter(die=>die.side===side);
    if(battle.lead)dice.reverse();
    $(container).replaceChildren(...dice.map(renderDie));
  }
  $('battle-log').replaceChildren(...battle.log.map(line=>html('li',line)));
  const pending=pendingEnemyDice(state).length;
  $('end-round').disabled=busy||!canEndRound(state);
  $('end-round').title=pending?pending+' enemy '+(pending===1?'die remains':'dice remain'):'End the turn and discard unused warden dice';
  const eligible=rerollableDice(state).length;
  $('reroll').hidden=!state.modifiers?.rerollAll;
  $('reroll').disabled=busy||!eligible;
  $('reroll').title=battle.rerollUsed?'Expedition perk · Reroll spent this turn':eligible?'Expedition perk · Reroll '+eligible+' unused '+(eligible===1?'die':'dice')+' of both sides · once per turn':'No dice eligible to reroll';
  const utility=$('reserve').parentElement;
  utility.hidden=battle.lead;
  utility.querySelector('summary').setAttribute('aria-label',battle.lead?'Combat items':'Reserve and Brace');
  utility.querySelector('summary').title=battle.lead?'Combat items':'Reserve and Brace';
  $('reserve').replaceChildren(html('span',battle.lead?`${state.pack.salve} Reed Salve`:battle.reserve?'Reserve available':'Reserve spent'));
  for(const key of battle.lead?[]:['guard','shift','salve']){
    const candidates=living(state.heroes).filter(hero=>{
      const plan=describe(state,'reserve',{actor:hero.key,action:key});
      return plan&&!plan.reason;
    });
    $('reserve').append(button(actions[key].name,()=>{
      $('reserve').parentElement.open=false;
      selection={id:'reserve',action:key,actor:candidates[0].key};renderCombat();
      $('command').querySelector('button')?.focus({preventScroll:true});
    },{className:'secondary',disabled:busy||!candidates.length}));
  }
  const tokenBar=$('combat-tokens');
  const lead=active(state.heroes)[0];
  tokenBar.replaceChildren();
  tokenBar.hidden=!battle.lead;
  for(const [key,token] of Object.entries(tokens)){
    for(let index=0;index<(state.pack[key]??0);index++){
      const plan=lead&&describe(state,'reserve',{actor:lead.key,action:key});
      const control=button(token.symbol,()=>{
        selection={id:'reserve',action:key,actor:lead.key};
        renderCombat();
        $('command').querySelector('button')?.focus({preventScroll:true});
      },{disabled:busy||!plan||Boolean(plan.reason)});
      control.title=plan?.reason||token.effect;
      control.setAttribute('aria-label','Use '+token.name);
      tokenBar.append(control);
    }
  }
  for(let index=tokenCount(state);index<tokenCapacity;index++)tokenBar.append(html('span','','empty-token'));
  const braceDice=battle.lead?[]:battle.dice.filter(die=>die.side==='party'&&describe(state,die.id,'brace'));
  if(braceDice.length)$('reserve').append(html('span','Spend a die as Brace'));
  for(const die of braceDice){
    const plan=describe(state,die.id,'brace');
    $('reserve').append(button(plan.actor.name,()=>{
      $('reserve').parentElement.open=false;
      selection={id:die.id,brace:true,target:plan.actor.key};
      void play();
    },{className:'secondary',disabled:busy||Boolean(plan.reason)}));
  }
  renderCommand();
  journey?.refresh();
}

function rollMotions(space,index){
  if(reduced())return [space.animate([{opacity:.35},{opacity:1}],{duration:150})];
  // Dicefolk RollCoroutine spins for .35–.75 s, then eases into the result for .25–.50 s.
  // Presentation variation stays separate from the gameplay RNG.
  const spin=(beats.rollSpinMin+Math.random()*beats.rollSpinRange)/settings.speed;
  const settle=(beats.rollSettleMin+Math.random()*beats.rollSettleRange)/settings.speed;
  const duration=spin+settle;
  const landing=spin/duration;
  const delay=index*beats.rollStagger/settings.speed;
  const side=space.closest('.die')?.classList.contains('foe')?-1:1;
  const opts={duration,delay,fill:'both'};
  const cube=space.querySelector('.cube');
  const drift=(index%2?1:-1)*6;
  const motions=[
    space.animate([
      {transform:'scale(.92)',offset:0,easing:'ease-out'},
      {transform:`translate(${drift}px,-32%) scale(1.12)`,offset:landing*.45,easing:'ease-in'},
      {transform:'scale(1.07)',offset:landing,easing:'ease-out'},
      {transform:'none',offset:1},
    ],opts),
    cube.animate([
      {transform:`rotateX(${side*-590}deg) rotateY(-470deg) rotateZ(-24deg)`,offset:0},
      {transform:`rotateX(${side*-54}deg) rotateY(-30deg) rotateZ(8deg)`,offset:landing,easing:beats.settleEase},
      {transform:'rotateX(0) rotateY(0) rotateZ(0)',offset:1},
    ],opts),
    space.querySelector('.dice-roll-burst').animate([
      {opacity:0,transform:'scale(.55)'},{opacity:.9,offset:.2},{opacity:0,transform:'scale(1.6)'},
    ],{duration:Math.min(settle,beats.rollBurst),delay:delay+spin,fill:'both'}),
  ];
  diceVfx.roll(space.closest('.die'),space,cube,motions[1],duration);
  return motions;
}
async function animateRoll(ids,message,reroll=false){
  cue(reroll?'reroll':settings.speed>1?'rollFast':'roll');
  busy=true;
  rollingDice=new Set(ids);
  selection=null;
  const status=$('roll-status');
  status.textContent=message;
  status.hidden=false;
  $('restart').disabled=true;
  $('title-menu').disabled=true;
  renderCombat();
  const motions=[...$('combat').querySelectorAll('.rolling')].flatMap(rollMotions);
  await Promise.allSettled(motions.map(animation=>animation.finished));
  rollingDice=null;
  busy=false;
  status.hidden=true;
  $('announcement').textContent=state.report;
  $('restart').disabled=false;
  $('title-menu').disabled=false;
  renderCombat();
}

function getOverride(){
  return selection?.id==='reserve'?{actor:selection.actor,action:selection.action}:selection?.brace?'brace':undefined;
}
function cancelSelection(){
  const previous=selection?.id;
  selection=null;
  renderCombat();
  document.getElementById('die-'+previous)?.focus({preventScroll:true});
}

function skillPreview(actor,key,side){
  const file=framedSkill(actor,key,side);
  if(!file)return null;
  const icon=html('img','','framed-skill-preview');
  icon.src=file;
  icon.alt='';
  return icon;
}

function renderBattleChoice(box,plan){
  box.classList.add('battle-choice');
  const choose=unit=>{selection.target=unit.key;void play();};
  const preview=unit=>arena.preview(plan.actor.key,unit?[unit.key]:[]);
  const bindPreview=(control,unit)=>{
    control.onpointerenter=control.onfocus=()=>preview(unit);
    control.onpointerleave=control.onblur=()=>preview();
  };
  const cancel=button('Cancel',cancelSelection,{className:'secondary'});
  if(plan.directions?.length){
    const choices=html('div','','rotation-choices');
    for(const {label,unit} of plan.directions){
      const control=button(label,()=>choose(unit));
      bindPreview(control,unit);
      choices.append(control);
    }
    choices.append(cancel);
    box.append(choices);
  }else{
    const rival=plan.targets.every(unit=>state.battle.enemies.includes(unit));
    box.append(html('span',rival?'Choose target enemy':'Choose target ally','battle-choice-label'),cancel);
    const controls=plan.targets.map(unit=>{
      const marker=button('',()=>choose(unit),{className:'unit-target'});
      marker.dataset.unit=unit.key;
      marker.setAttribute('aria-label','Target '+unit.name);
      marker.append(html('span','▼','unit-target-pointer'));
      bindPreview(marker,unit);
      return marker;
    });
    $('target-layer').replaceChildren(...controls);
    positionTargets();
  }
  preview();
}

function renderCommand(){
  const box=$('command');
  const plan=selection&&describe(state,selection.id,getOverride());
  arena.clearPreview();
  $('target-layer').replaceChildren();
  box.classList.remove('battle-choice');
  box.hidden=!plan;
  if(!plan){box.replaceChildren();return;}
  box.replaceChildren();
  const skill=skillPreview(plan.actor.id,plan.key,plan.enemy?'foe':'party');
  if(skill)box.append(skill);
  if(state.battle.lead&&!plan.reserve){renderBattleChoice(box,plan);return;}
  const row=html('div','','button-row');
  const resolveButton=button('✓',play,{disabled:busy||Boolean(plan.reason),className:'resolve-action'});
  resolveButton.setAttribute('aria-label','Resolve '+plan.name);
  resolveButton.title='Resolve '+plan.name;
  row.append(html('strong',plan.name+(plan.engraved?' ◆':'')),resolveButton);
  resolveButton.hidden=!plan.reserve&&plan.targets.length>1&&!selection.target;
  if(!state.battle.lead&&!plan.enemy&&!plan.reserve&&!selection.brace)row.append(button('Brace',()=>{
    selection.brace=true;selection.target=null;renderCommand();
    $('command').querySelector('button')?.focus();
  },{className:'secondary',disabled:busy}));
  const cancel=button('×',()=>{
    const previous=selection.id;selection=null;renderCombat();
    (document.getElementById('die-'+previous)??document.querySelector('.reserve summary'))?.focus();
  },{className:'secondary'});
  cancel.setAttribute('aria-label','Cancel action');
  row.append(cancel);
  box.append(row);
  if(selection.id==='reserve'&&!tokens[selection.action]){
    const actor=html('select');actor.setAttribute('aria-label','Reserve actor');
    for(const unit of living(state.heroes)){
      const candidate=describe(state,'reserve',{actor:unit.key,action:selection.action});
      if(candidate&&!candidate.reason)actor.add(new Option(unit.name,unit.key));
    }
    actor.value=selection.actor;
    actor.onchange=()=>{selection.actor=actor.value;selection.target=null;renderCommand();};
    box.append(actor);
  }
  const forecast=html('p','','forecast');
  const info=html('details','','action-details');
  info.append(html('summary','Details'));
  if(plan.action.text)info.append(html('p',plan.action.text));
  if(plan.enemy)info.append(html('p','Target · '+plan.targets.map(unit=>unit.name).join(' / ')));
  const updateForecast=()=>{
    const projected=plan.reason||expeditionId?null:resolve(structuredClone(state),selection.id,selection.target,getOverride());
    forecast.textContent=projected?.changes.length?'Expected · '+projected.changes.map(change=>change.text).join(' / '):'';
    forecast.hidden=!forecast.textContent;
  };
  if((!plan.enemy||plan.choose)&&plan.targets.length){
    const select=html('select');select.setAttribute('aria-label','Action target');
    for(const unit of plan.targets)select.add(new Option(unit.name,unit.key));
    if(!plan.targets.some(unit=>unit.key===selection.target))selection.target=plan.targets.length===1?plan.targets[0].key:null;
    select.prepend(new Option('Choose a target',''));
    select.value=selection.target??'';
    select.disabled=busy;
    if(plan.targets.length>1&&!plan.reason){
      const controls=plan.targets.map(unit=>{
        const marker=button('⌄',()=>{selection.target=unit.key;void play();},{className:'target-marker',disabled:busy});
        marker.id='target-'+unit.key;
        marker.dataset.unit=unit.key;
        marker.setAttribute('aria-label',(plan.action.type==='rotate'?'Lead with ':'Target ')+unit.name);
        marker.setAttribute('aria-pressed',String(selection.target===unit.key));
        marker.title=unit.name;
        marker.onpointerenter=marker.onfocus=()=>arena.preview(plan.actor.key,[unit.key]);
        marker.onpointerleave=marker.onblur=()=>arena.preview(plan.actor.key,selection?.target?[selection.target]:[]);
        return marker;
      });
      $('target-layer').replaceChildren(...controls);
      positionTargets();
      const label=html('label','Target ');
      label.append(select);
      info.append(label);
      select.onchange=()=>{selection.target=select.value;renderCommand();$('command').querySelector('.action-details').open=true;$('command').querySelector('[aria-label="Action target"]').focus();};
    }
  }
  updateForecast();
  if(plan.reason)box.append(html('p',plan.reason,'warning'));
  info.append(forecast);
  if(plan.action.text||plan.enemy||!forecast.hidden||info.querySelector('select'))box.append(info);
  if(!plan.reason)arena.preview(plan.actor.key,plan.enemy&&!plan.choose?plan.targets.map(unit=>unit.key):selection.target?[selection.target]:[]);
}

function positionTargets(){
  for(const marker of $('target-layer').children){
    if(marker.classList.contains('unit-target')){
      const {x,y,width,height}=arena.projectUnit(marker.dataset.unit,state);
      Object.assign(marker.style,{left:x+'px',top:y+'px',width:width+'px',height:height+'px'});
      continue;
    }
    const [x,y]=arena.project(marker.dataset.unit,state);
    marker.style.left=x+'px';marker.style.top=y+'px';
  }
}
new ResizeObserver(positionTargets).observe($('arena'));

$('end-round').onclick=()=>{
  if(busy||!canEndRound(state))return;
  arena.endTurn();
  void update(()=>endRound(state),{type:'end-round',round:state.battle.round});
  if(!expeditionId)journey?.notify('round');
};
$('reroll').onclick=async()=>{
  if(busy)return;
  if(expeditionId){
    const ids=rerollableDice(state).map(die=>typeof die==='string'?die:die.id);
    if(!ids.length)return;
    if(await submitExpedition({type:'reroll',round:state.battle.round}))void animateRoll(ids,'Rerolling unused dice',true);
    else {render();showExpeditionError('Reroll could not be confirmed.');}
    return;
  }
  const ids=rerollDice(state);
  if(!ids.length)return;
  save();
  void animateRoll(ids,'Rerolling unused dice',true);
};
async function play(){
  if(busy||!selection)return;
  const before=structuredClone(state);
  const {id,target}=selection;
  const override=getOverride();
  const result=expeditionId
    ? await submitExpedition({type:'use-die',dieId:id,round:state.battle.round,targetKey:target??undefined,itemId:override?.action,brace:override==='brace'||undefined})
    : resolve(state,id,target,override);
  if(!result){
    if(expeditionId){render();showExpeditionError('Action could not be confirmed. Retry or reopen Expedition Kit.');}
    return;
  }
  const activated=document.getElementById('die-'+id);
  if(activated){
    diceVfx.highlight(activated,false);
    diceVfx.shatter(activated);
    activated.dataset.state='resolving';
  }
  busy=true;selection=null;
  if(!expeditionId)journey?.notify('action',result);
  save();
  $('command').hidden=true;
  $('target-layer').replaceChildren();
  $('combat').querySelectorAll('button,select').forEach(control=>control.disabled=true);
  $('restart').disabled=true;
  $('title-menu').disabled=true;
  journey?.refresh();
  try{await arena.play(before,state,result);}
  catch(error){console.error(error);$('announcement').textContent='Action resolved. Animation could not finish.';}
  finally{
    if(state.phase==='reward'||state.phase==='defeat')await showBattleOutcome();
    else{busy=false;render();}
  }
}

async function showBattleOutcome(){
  busy=true;
  journey?.refresh();
  const outcome=$('battle-outcome');
  const victory=state.phase==='reward';
  const title=html('strong',victory?'Victory':'Defeat');
  outcome.dataset.result=victory?'victory':'defeat';
  outcome.replaceChildren(title);
  const lead=active(state.heroes)[0];
  const featured=lead??state.heroes.find(hero=>!hero.bench);
  if(featured)outcome.append(wardenPreview(featured.id,{animate:!reduced()}));
  if(victory){
    if(state.battle.copperEarned)title.append(html('small','+'+state.battle.copperEarned+' Copper','victory-copper'));
    cue('win');
    if(!reduced())for(let index=0;index<52;index++){
      const fleck=html('i');
      fleck.style.setProperty('--fall-x',((index*43)%100)+'%');
      fleck.style.setProperty('--fall-delay',((index*37)%1100)+'ms');
      fleck.style.setProperty('--fall-color',['#f2c164','#acdfa4','#e2a18a'][index%3]);
      outcome.append(fleck);
    }
  }
  if(!victory&&!reduced())for(let index=0;index<24;index++){
    const ash=html('i');
    ash.style.setProperty('--fall-x',(24+(index*13)%53)+'%');
    ash.style.setProperty('--fall-delay',((index*53)%740)+'ms');
    ash.style.setProperty('--fall-color',['#9f755f','#675069','#da765a'][index%3]);
    outcome.append(ash);
  }
  const hud=document.querySelector('.battle-hud');
  hud.inert=true;
  const hold=victory&&currentNode(state).type==='boss'?cinematic.outroFinalHold:cinematic.outroHold;
  const duration=reduced()?(victory?1500:360):hold+cinematic.titleExit;
  outcome.hidden=false;
  if(!reduced()){
    const timing={enter:cinematic.outroEnter,exit:cinematic.titleExit,duration};
    motionWindow(title,{opacity:0,transform:'translateY(-14px)'},{opacity:1,transform:'none'},{opacity:0,transform:'translateY(-5px)'},timing);
    motionWindow(outcome.querySelector('canvas'),
      {opacity:0,transform:'translate(-50%,100%)'},
      {opacity:1,transform:'translate(-50%,0)'},
      {opacity:0,transform:'translate(-50%,17%)'},timing);
  }
  try{await new Promise(resolve=>setTimeout(resolve,duration));}
  finally{
    outcome.hidden=true;
    outcome.replaceChildren();
    busy=false;
    if(isEmptyBattleReward()){
      if(expeditionId)await submitExpedition({type:'claim',choice:'leave'});
      else if(claim(state,'leave'))save();
    }
    render();
  }
}

function render(){
  $('region-name').textContent=regionOf(currentNode(state)).name;
  const inCombat=state.phase==='battle';
  const lootScene=hasTutorialLoot(state);
  const stage=state.phase+':'+state.node;
  document.body.dataset.phase=state.phase;
  document.body.classList.toggle('tutorial-loot',lootScene);
  document.body.classList.toggle('field-loot',state.phase==='reward'&&!lootScene);
  const enteringStage=stage!==lastStage;
  if(enteringStage){
    for(const menu of utilities)menu.open=false;
    const layer=inCombat?$('combat'):$('travel');
    if(!reduced()){
      const fromLoot=state.phase==='map'&&lastStage?.startsWith('reward:');
      const frames=fromLoot?[
        {clipPath:'polygon(43% 0,47% 0,56% 100%,52% 100%)'},
        {clipPath:'polygon(0 0,100% 0,100% 100%,0 100%)'},
      ]:[{opacity:0},{opacity:1}];
      layer.animate(frames,{duration:fromLoot?beats.sceneOut:beats.sceneIn,easing:'ease-out'});
      if(state.phase==='map'){
        $('route-scroll').animate([{transform:'scale(.95)',opacity:.65},{transform:'scale(1)',opacity:1}],
          {duration:beats.sceneIn,easing:beats.settleEase});
      }
    }
    lastStage=stage;
  }
  $('travel').hidden=inCombat;
  $('combat').hidden=!(inCombat||lootScene);
  $('combat').inert=lootScene;
  $('journal').hidden=!inCombat;
  $('field-guide').hidden=state.phase!=='map';
  $('restart').disabled=busy;
  $('title-menu').disabled=busy;
  $('purse').textContent='◉ '+state.copper;
  $('purse').setAttribute('aria-label',state.copper+' Copper');
  $('purse').title=state.copper+' Copper';
  $('satchel').textContent=tokenCount(state)+' / '+tokenCapacity+' combat tokens · '+
    (Object.entries(tokens).filter(([key])=>state.pack[key]).map(([key,token])=>state.pack[key]+' '+token.name).join(' · ')||'Empty pouch')+
    ' · '+state.pack.heartwood+' Heartwood'+
    (state.pack.letter?' · Lost Letter':'')+(state.pack.charm?' · Bramble Charm':'');
  $('announcement').textContent=state.report;
  renderParty();
  if(inCombat){
    const lesson=lessonPage(state)?.[0];
    const combat=$('combat');
    const reveal=lesson==='allies'&&combat.dataset.lesson!=='allies';
    combat.dataset.lesson=lesson??'';
    document.querySelector('.battle-hud').inert=Boolean(lesson);
    const stamp=state.node+':'+state.battle.round;
    const showRoll=!lesson||['light','dark','controls'].includes(lesson);
    if(showRoll&&stamp!==rollStamp){
      rollStamp=stamp;
      void animateRoll(state.battle.dice.map(die=>die.id),'Rolling both sides');
    }else renderCombat();
    const field=battleBackdrop(currentNode(state));
    $('arena').style.backgroundImage='url("'+asset(field)+'")';
    if(reveal)arena.revealAllies();
    arena.show(state,field).then(()=>{
      if(enteringStage&&!lesson&&lastStage===stage&&state.phase==='battle')arena.revealEncounter();
      if(lessonPage(state)?.[0]==='versus')journey?.refresh();
    }).catch(error=>{
      $('action-flash').textContent='Arena art could not load. Battle controls are available.';
      $('battlefield').dataset.assetError='true';
      journey?.refresh();
      console.error(error);
    });
  }else{
    if(lootScene){
      if(!$('battlefield').dataset.arena)arena.show(state,battleBackdrop(currentNode(state))).catch(console.error);
    }else arena.stop();
    if(state.phase==='map')renderMap();
    renderDecision();
    if(enteringStage&&hasTutorialLoot(state)&&!reduced()){
      for(const [id,direction] of [['loot-diary',-1],['decision',1]])
        $(id).animate([{opacity:0,transform:`translateX(${direction<0?-100:12}%)`},{opacity:1,transform:'none'}],
          {duration:cinematic.sceneIn,easing:'ease-out'});
    }
  }
  journey?.refresh();
}
journey=createJourney({getState:()=>state,saveRun:save,isBusy:()=>busy,reduced,wardenPreview,
  hasSave:()=>savedRunAvailable,
  deleteSave:()=>{try{localStorage.removeItem(storage);}catch{}savedRunAvailable=false;state=fresh();selection=null;rollStamp='';render();},
  newJourney:(tutorial,options)=>{
    state=fresh(tutorial,{...options,runId:crypto.randomUUID()});rollStamp='';selection=null;
    state.enterOnResume=true;
    save();
  },
  resume:()=>{
    const atOpeningMap=state.phase==='map'&&state.node==='threshold';
    if(state.enterOnResume||atOpeningMap){
      delete state.enterOnResume;
      delete state.openingPending;
      if(!atOpeningMap)chooseEvent(state,'enter');
      state.tutorial.introPage=0;
      if(state.tutorial.enabled)state.tutorial.videoVersion=1;
      enter(state,'road');
    }
    save();render();
  },
});
$('title-menu').onclick=()=>journey.title();
$('settings').querySelector('summary').onclick=event=>{if(!expeditionId){event.preventDefault();journey.pause();}};
async function launchRewardedExpedition(){
  $('save-status').textContent='Saved to your account';
  $('restart').hidden=true;
  $('title-menu').textContent='Expedition Kit';
  $('title-menu').onclick=()=>location.assign('/online-expedition.html');
  try{
    remoteRun=await expeditionApi('');
    if(remoteRun.mode!=='expedition'||!remoteRun.state)throw new Error('Invalid expedition');
    state=remoteRun.state;
    if(remoteRun.version===0&&(remoteRun.loadoutPreparation?.purseAtomic||remoteRun.loadoutPreparation?.ownedItems)){
      location.replace('/online-expedition.html');
      return;
    }
    $('title-loading').remove();
    render();
  }catch{
    const loading=$('title-loading');
    const back=html('a','Return to Expedition Kit');
    back.href='/online-expedition.html';
    loading.replaceChildren(html('div','This expedition could not be opened.'),back);
  }
}
if(expeditionId)void launchRewardedExpedition();
else {render();journey.launch();}
