import {regionalBossMoves} from './expedition-data.mjs';
import {companions,SUMMON_FACE} from './expedition-companions.mjs';

const heroSkills={
  rook:{strike:'mason_s_blow','brace-line':'brace_the_line','take-weight':'take_the_weight','stone-answer':'stone_answer'},
  mara:{strike:'oarhook',undertow:'undertow','open-seam':'open_seam','ferry-line':'ferry_line'},
  elian:{strike:'tuning_strike','mending-note':'mending_note','fracture-chime':'fracture_chime','clear-tone':'clear_tone'},
  tess:{strike:'courier_s_shot','red-thread':'red_thread','pin-hem':'pin_the_hem','final-delivery':'final_delivery'},
};
const bossSkills={rake:'root-scythe',guard:'root-gate',graft:'graft-link',sweep:'three-door-buds'};
const common=['ranged','guard','rotate-left','rotate','rotate-random','idle','bulk-up','shift','brace','stone-answer',
  'witness-seal','ferrymans-knot','wayfarers-lamp','iron-needle','salve','strike'];
const hostile=['rake','lunge','thorn','pierce','pull','root','bark','graft','guard','idle','sweep','siege',
  'foe-boost','foe-purify','foe-target','clash'];
const assets='./combat-assets/';

export function framedSkill(actor,key,side){
  if(side==='foe'){
    if(regionalBossMoves[actor]?.includes(key))return assets+'enemy-intents-v1/'+actor+'/'+key+'.png';
    return actor==='mother'&&bossSkills[key]?assets+'enemy-intents-v1/mother-of-closed-doors/'+bossSkills[key]+'.png':null;
  }
  const file=heroSkills[actor]?.[key];
  return file?assets+'skill-icons-v7/'+actor+'/'+actor+'_'+file+'.png':null;
}

export function dicePainting(actor,key,side){
  if(side==='party'&&key===SUMMON_FACE){
    if(Object.hasOwn(companions,actor))return {companion:assets+actor+'.png'};
    return {atlas:'party',index:common.indexOf('idle')};
  }
  if(side==='party'&&actor==='mara'&&key==='strike')return {cutout:assets+'dice-oarhook-cutout-v1.png'};
  const framed=framedSkill(actor,key,side);
  if(framed)return {framed};
  const flip=key==='rotate-right';
  if(flip)key='rotate-left';
  if(side==='foe'){
    if(key==='curse')return {atlas:'foe',index:hostile.indexOf('foe-target')};
    key=({'foe-strike':'rake','foe-tech':'thorn','foe-ranged':'pierce'})[key]??key;
    const index=hostile.indexOf(key);
    if(index>=0)return {atlas:'foe',index};
  }
  if(key==='guard-token')key='guard';
  if(key==='purify-token')return {atlas:'foe',index:13};
  if(key==='heal-all'||key==='full-heal-all')key='salve';
  const index=common.indexOf(key);
  return index>=0?{atlas:'party',index,flip}:null;
}

export function paintDiceFace(element,actor,key,side){
  const art=dicePainting(actor,key,side);
  if(!art)throw new Error('Missing painted dice face: '+side+' '+actor+' '+key);
  const icon=document.createElement('span');
  icon.className='dice-painted-icon';
  icon.setAttribute('aria-hidden','true');
  if(art.companion){
    icon.style.backgroundImage='url('+art.companion+')';
    icon.style.backgroundPosition='0 0';
    icon.style.backgroundSize='400% 200%';
  }else if(art.framed||art.cutout){
    const image=document.createElement('img');
    image.src=art.cutout??art.framed;
    image.alt='';
    icon.classList.add(art.cutout?'dice-skill-cutout':'dice-skill-crop');
    icon.append(image);
  }else{
    icon.dataset.atlas=art.atlas;
    icon.style.backgroundPosition=(art.index%4)*100/3+'% '+Math.floor(art.index/4)*100/3+'%';
    if(art.flip)icon.classList.add('dice-icon-flip');
  }
  element.append(icon);
}

