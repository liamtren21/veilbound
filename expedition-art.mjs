import {createBattleVfx} from './expedition-battle-vfx.mjs';
import {foes} from './expedition-data.mjs';
import {companions} from './expedition-companions.mjs';
import {cinematic} from './expedition-cinematics.mjs';
import {settings,cue,cueAttack} from './expedition-options.mjs?v=sfx-v2';
import {focusAmount} from './combat-camera.mjs';
import {drawEncounterEffect} from './boss-encounter-effects.mjs';
import {actions as encounterActions} from './boss-encounter-actions.mjs';
import {actionEffects, beats, combatMotion, impactAt, paintMotion, rotationEase} from './expedition-motion-library.mjs?v=sfx-v2';

export const asset = file => './combat-assets/'+file;
const imageCache = new Map();
const bossDeathWindup = 520;
function loadImage(file) {
  if(!imageCache.has(file)){
    const image=new Image();
    const resource=new Promise((resolve,reject)=>{
      image.onload=()=>resolve(image);
      image.onerror=()=>reject(new Error('Missing artwork: '+file));
    });
    image.src=asset(file);
    imageCache.set(file,resource);
  }
  return imageCache.get(file);
}
const json=async file=>{
  const response=await fetch(asset(file));
  if(!response.ok)throw new Error('Missing art manifest: '+file);
  return response.json();
};
const support=await json('support-assets-v1.json');
const monsters=support['wood-bestiary'];
const monstersImage=loadImage(monsters.file);
const protection=json('protection-atlases-v2.json');
const skills=json('skill-icon-tiers-v1.json');

const routeMarks = {
  Battle:'battle', Elite:'elite', Boss:'boss', Merchant:'merchant', Camp:'camp',
  Copper:'coin', Story:'story', 'Hidden Trail':'hidden', Crossing:'crossing',
  'Supply Cache':'merchant',
};

export function routeIcon(name){
  const icon=document.createElement('img');
  icon.className='route-mark';
  icon.alt='';
  const mark=routeMarks[name]??routeMarks.Story;
  icon.src=asset('route-mark-'+mark+'-v2.webp');
  return icon;
}

export async function skillArt(){
  const groups=(await skills).groups.filter(group=>group.form==='base');
  return (hero,name)=>groups.find(group=>group.heroId===hero)?.skills.find(skill=>skill.name===name)?.png;
}

const frameClips = new Map();
const encounterMotion=json('boss-encounter-motion-v1.json');
const encounterEffects=json('boss-encounter-effects-v2.json');
const isBoss=unit=>foes[unit?.id]?.behavior==='boss';
async function loadClips(id) {
  const foe=foes[id];
  const definitions=isBoss({id})||foe?.encounter?
    (await encounterMotion).find(entry=>entry.assetId===(foe.clip??foe.art)).clips:
    id==='mara'?null:(await json(id+'-manifest.json')).clips;
  if(!definitions){
    return Object.fromEntries(await Promise.all(['idle','attack'].map(async kind=>{
      const image=await loadImage(kind+'.png'), w=image.width/6,h=image.height/2;
      return [kind,{image,frames:Array.from({length:12},(_,i)=>({rect:[i%6*w,Math.floor(i/6)*h,w,h],pivotX:.5,pivotY:.08}))}];
    })));
  }
  return Object.fromEntries(await Promise.all(Object.entries(definitions).map(async ([kind,clip])=>
    [kind,{...clip,image:await loadImage(clip.file)}])));
}
const clips=id=>{
  if(!frameClips.has(id))frameClips.set(id,loadClips(id));
  return frameClips.get(id);
};
const previewMotions = new WeakMap();
export function playWardenPreview(canvas, clip) {
  return previewMotions.get(canvas)?.(clip);
}
export function wardenPreview(id,{animate=false,highResolution=false}={}){
  const canvas=document.createElement('canvas');
  canvas.width=highResolution?480:animate?320:160;canvas.height=highResolution?585:animate?390:195;canvas.setAttribute('aria-hidden','true');
  const monster = monsters.frames.find(frame => frame.name === foes[id]?.art);
  if (monster && !isBoss({id}) && !foes[id]?.encounter) {
    let strikeAt=-Infinity;
    if(animate) previewMotions.set(canvas,async ()=>{
      strikeAt=performance.now();
      await new Promise(resolve=>setTimeout(resolve,440));
    });
    void monstersImage.then(image => {
      const [x,y,w,h] = monster.rect;
      const context=canvas.getContext('2d');
      const scale=Math.min(canvas.width/w,canvas.height/h)*.9;
      const render=now=>{
        if(!canvas.isConnected)return;
        const breath=animate?Math.sin(now/330)*.017:0;
        const lunge=Math.max(0,1-Math.abs((now-strikeAt)/220-1));
        const height=h*scale*(1+breath-lunge*.035);
        context.clearRect(0,0,canvas.width,canvas.height);
        context.drawImage(image,x,y,w,h,(canvas.width-w*scale)/2-lunge*canvas.width*.09,
          canvas.height-height,w*scale,height);
        if(animate)requestAnimationFrame(render);
      };
      render(performance.now());
    }).catch(()=>{});
    return canvas;
  }
  const ready=clips(id);
  let motion;
  if(animate) previewMotions.set(canvas,async kind=>{
    const clip=(await ready.catch(()=>null))?.[kind];
    if(!clip || !canvas.isConnected) return;
    const duration=clip.durationMs??(kind==='attack'?620:760);
    motion={clip,start:performance.now(),duration};
    await new Promise(resolve=>setTimeout(resolve,duration));
  });
  void ready.then(({idle})=>{
    const context=canvas.getContext('2d');
    const start=performance.now();
    const render=now=>{
      if(!canvas.isConnected)return;
      const age=motion?now-motion.start:0;
      const active=motion&&age<motion.duration;
      const clip=active?motion.clip:idle;
      const frame=active?Math.min(clip.frames.length-1,Math.floor(Math.max(0,age)/motion.duration*clip.frames.length)):
        animate?Math.floor(Math.max(0,now-start)/105)%idle.frames.length:0;
      const [x,y,w,h]=clip.frames[frame].rect;
      const scale=Math.min(canvas.width/w,canvas.height/h);
      context.clearRect(0,0,canvas.width,canvas.height);
      context.drawImage(clip.image,x,y,w,h,(canvas.width-w*scale)/2,canvas.height-h*scale,w*scale,h*scale);
      if(animate)requestAnimationFrame(render);
    };
    render(start);
  }).catch(()=>{});
  return canvas;
}
const width=1200,height=560,contact=beats.contact;
const partySlots=[[457,428],[337,390],[255,464],[155,405]];
const enemySlots=[[775,432],[960,415]];
const portraitPartySlots=[[460,434],[315,365],[330,511],[206,442]];
const portraitEnemySlots=[[778,430],[935,367]];
const mix=(a,b,t)=>a+(b-a)*t;
const clamp=(n,min=0,max=1)=>Math.max(min,Math.min(max,n));
const heroDurations=[140,100,100,90,65,65,100,80,90,110,130,250];
const hitSheets={
  'rook-effects.png':3,'rook-stonefall.png':2,'mara-physical.png':2,'undertow.png':2,
  'elian-effects.png':3,'tess-effects.png':3,
};
function hitArt(hero,key){
  if(hero==='rook')return ['rook-effects.png',0,4];
  if(hero==='mara')return key==='undertow'?['undertow.png',0,8]:['mara-physical.png',key==='open-seam'?1:0,4];
  if(hero==='elian')return ['elian-effects.png',key==='fracture-chime'?1:key==='mending-note'?2:0,4];
  return ['tess-effects.png',key==='red-thread'?1:key==='pin-hem'?2:0,4];
}
const motionFrame=age=>{
  let elapsed=0;
  const i=heroDurations.findIndex(span=>(elapsed+=span)>age);
  return i<0?11:i;
};

export function createArena(canvas, reduced, flash) {
  const ctx=canvas.getContext('2d');
  let current, backdrop, healthTrack, art={}, bossEffects=[], playing=null, tick=0, queued=0, ready=false, arenaFile;
  let arrivalAt=-Infinity;
  let foeArrivalAt=-Infinity;
  let turnAt=-Infinity;
  const portrait=()=>canvas.clientWidth<canvas.clientHeight;
  const isFoe=(key,state)=>state.battle.enemies.some(unit=>unit.key===key);
  const slot=(key,state)=>{
    const foe=isFoe(key,state);
    const team=(foe?state.battle.enemies:state.heroes).filter(unit=>!unit.bench);
    if(state.battle.lead)team.sort((a,b)=>Number(b.hp>0)-Number(a.hp>0));
    const index=team.findIndex(unit=>unit.key===key);
    if(index<0)return [width/2,height*.7];
    if(portrait())return foe?(isBoss(team[index])?[867,448]:portraitEnemySlots[index]):portraitPartySlots[index];
    return foe?(isBoss(team[index])?[914,445]:enemySlots[index]):partySlots[index];
  };
  const layout=()=>{
    const w=canvas.clientWidth||width,h=canvas.clientHeight||height;
    const vertical=w<h;
    const scale=Math.min(w/(vertical?1000:width),h/535);
    return {w,h,scale,x:(w-width*scale)/2,y:h*(vertical?.62:.7)-425*scale};
  };

  async function show(state,file) {
    current=state;
    if(file===arenaFile&&ready)return;
    arenaFile=file;
    const token=++queued;
    ready=false;
    delete canvas.dataset.arena;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const boss=state.battle.enemies.find(isBoss);
    const animatedFoes=state.battle.enemies.filter(unit=>isBoss(unit)||foes[unit.id]?.clip);
    const sprites=new Set([...state.heroes,...animatedFoes].map(unit=>unit.id));
    const batch=await Promise.all([
      loadImage(file),monstersImage,
      Promise.all([...sprites].map(async id=>[id,await clips(id)])),
      boss?encounterEffects.then(data=>Promise.all(data[foes[boss.id].art].map(async entry=>({...entry,image:await loadImage(entry.file)})))):[],
      protection.then(data=>Promise.all(['brace','cover','ferry','witness'].map(async key=>[key,{...data[key],image:await loadImage(data[key].file)}]))),
      Promise.all(Object.keys(hitSheets).map(async file=>[file,await loadImage(file)])),
      loadImage('ui-orchard-v1/health-track.png'),
      Promise.all(Object.keys(companions).map(async id=>[id,await loadImage(id+'.png')])),
    ]);
    if(token!==queued)return;
    const [background, monsterSprites, sheets, effects, wards, hits, track, pets]=batch;
    backdrop=background;
    healthTrack=track;
    art={...Object.fromEntries([...sheets,...wards,...hits,...pets]),monsters:monsterSprites};
    bossEffects=effects;
    ready=true;
    canvas.dataset.arena=file;
    if(!tick)tick=requestAnimationFrame(draw);
  }

  function sprite(image,frame,x,y,worldHeight,mirror=false){
    const rect=frame.rect;
    const w=worldHeight*rect[2]/rect[3];
    ctx.save();
    ctx.translate(x,y);
    if(mirror)ctx.scale(-1,1);
    ctx.drawImage(image,...rect,-w*(frame.pivotX??.5),-worldHeight*(1-(frame.pivotY??0)),w,worldHeight);
    ctx.restore();
  }

  function label(unit,x,y,enemy){
    const length=isBoss(unit)?152:96;
    const vertical=portrait();
    ctx.textAlign='center';
    ctx.font=(vertical?23:14)+'px "Bubblegum Sans", system-ui';
    ctx.fillStyle='#f5e5c5';
    ctx.strokeStyle='#1b1814';ctx.lineWidth=4;ctx.lineJoin='round';
    const short=unit.name.replace(/^The /,'').split(' ')[0];
    const name=(unit.iridescent?'✦ ':'')+(vertical?short:unit.name);
    ctx.strokeText(name,x,y+27,length+24);ctx.fillText(name,x,y+27,length+24);
    ctx.drawImage(healthTrack,x-length/2-4,y+29,length+8,13);
    const segmentWidth=(length-4)/8;
    const health=Math.max(0,Math.min(1,unit.hp/unit.maxHp))*8;
    for(let segment=0;segment<8;segment++){
      const left=x-length/2+2+segment*segmentWidth;
      const fill=(segmentWidth-1)*Math.max(0,Math.min(1,health-segment));
      ctx.fillStyle=enemy?'#382539':'#371b1c';
      ctx.fillRect(left,y+33,segmentWidth-1,5);
      ctx.fillStyle=enemy?'#b178bd':'#d46756';
      ctx.fillRect(left,y+33,fill,5);
    }
    if(unit.guard){
      ctx.fillStyle='#f5d18a';
      ctx.fillText('◆',x+length/2+9,y+27);
    }
    if(unit.ward){
      ctx.fillStyle='#77cfda';
      ctx.fillRect(x-length/2,y+43,length*Math.min(30,unit.ward)/30,3);
    }
  }
  let battleVfx;
  function strokeMark(x,y,color,radius,alpha=.88){
    ctx.save();
    ctx.translate(x,y);
    ctx.scale(1,.25);
    ctx.globalAlpha=alpha;
    ctx.strokeStyle='#201614';
    ctx.lineWidth=10;
    ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.stroke();
    ctx.strokeStyle=color;
    ctx.lineWidth=5;
    ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.stroke();
    ctx.lineWidth=3;
    for(const angle of [0,Math.PI/2,Math.PI,Math.PI*1.5]){
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle)*(radius-7),Math.sin(angle)*(radius-7));
      ctx.lineTo(Math.cos(angle)*(radius+7),Math.sin(angle)*(radius+7));
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawArrival(x,y,age){
    const progress=age/cinematic.spawn;
    ctx.save();
    ctx.translate(x,y-46);
    ctx.globalCompositeOperation='lighter';
    ctx.globalAlpha=Math.min(1,age/130)*(1-progress)**1.5;
    ctx.strokeStyle='#ffdc82';ctx.fillStyle='#fff4c2';ctx.lineWidth=2;
    const radius=29+Math.sin(Math.PI*progress)*23;
    for(const scale of [1,.77]){
      ctx.beginPath();ctx.ellipse(0,0,radius*scale,radius*scale,0,0,Math.PI*2);ctx.stroke();
    }
    for(let i=0;i<12;i++){
      const angle=i*Math.PI/6+progress*1.7;
      const distance=radius+progress*(18+i%3*9);
      const px=Math.cos(angle)*distance,py=Math.sin(angle)*distance-progress*30;
      ctx.fillRect(px-1.5,py-1.5,3,3);
    }
    ctx.restore();
  }
  function aim(from,to){
    const dx=to[0]-from[0],dy=to[1]-from[1];
    if(Math.abs(dx)<8&&Math.abs(dy)<8)return;
    const distance=Math.hypot(dx,dy),unitX=dx/distance,unitY=dy/distance;
    const gap=Math.min(38,distance*.24);
    const a=[from[0]+unitX*gap,from[1]+unitY*gap];
    const b=[to[0]-unitX*gap,to[1]-unitY*gap];
    const bend=Math.min(34,distance*.15);
    const color=dx>0?'#ffd19a':'#f4a1a7';
    function trace(){
      ctx.beginPath();
      ctx.moveTo(...a);
      ctx.quadraticCurveTo((a[0]+b[0])/2,(a[1]+b[1])/2-bend,...b);
    }
    ctx.save();
    ctx.lineCap='round';
    ctx.strokeStyle='#251919';ctx.lineWidth=6;trace();ctx.stroke();
    ctx.strokeStyle=color;ctx.lineWidth=2.6;
    ctx.setLineDash([8,7]);
    ctx.lineDashOffset=reduced()?0:-performance.now()/40;
    trace();ctx.stroke();
    ctx.setLineDash([]);
    ctx.translate(...b);ctx.rotate(Math.atan2(dy+2*bend,dx));
    ctx.fillStyle=color;ctx.strokeStyle='#251919';ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(4,0);ctx.lineTo(-15,-8);ctx.lineTo(-10,0);ctx.lineTo(-15,8);
    ctx.closePath();ctx.stroke();ctx.fill();
    ctx.restore();
  }
  function draw(now) {
    tick=0;
    if(!ready||!current||!current.battle)return;
    const progress=playing?(now-playing.started)*(playing.speed??1):-1;
    const event=playing?.result;
    const stone=event?.key==='stone-answer';
    const resultAt=impactAt(event?.key);
    const shown=event&&progress<resultAt?playing.before:current;
    const motion=event&&!reduced();
    const lesson=canvas.closest('#combat')?.dataset.lesson;
    const attacker=event&&shown.battle.enemies.find(unit=>unit.key===event.actor);
    const bossAction=isBoss(attacker);
    const targets=event?.targets??[];
    const affected=event?.art==='ferry'?[event.actor,...targets]:targets;
    const combo=bossAction&&targets.length>1;
    const {w,h,x:ox,y:oy,scale}=layout();
    const dpr=Math.min(devicePixelRatio||1,2)*settings.resolution/100;
    const pixelsW=Math.round(w*dpr),pixelsH=Math.round(h*dpr);
    if(canvas.width!==pixelsW||canvas.height!==pixelsH){canvas.width=pixelsW;canvas.height=pixelsH;}
    const striking=['hit','pull'].includes(event?.type);
    const rotating=event?.type==='rotate';
    const zoom=motion&&striking?1+(combo?.045:w/h<1?.055:.14)*focusAmount(progress/1000,resultAt/1000):1;
    const area=event&&targets.length?slot(targets[0],shown):[600,320];
    const origin=event?slot(event.actor,shown):[600,320];
    const cameraX=combo?width/2:mix((origin[0]+area[0])/2,area[0],.27);
    const pivotX=ox+scale*cameraX,pivotY=oy+scale*345;
    ctx.setTransform(dpr*zoom,0,0,dpr*zoom,dpr*pivotX*(1-zoom),dpr*pivotY*(1-zoom));
    const cover=Math.max(w/backdrop.width,h/backdrop.height);
    const backdropWidth=backdrop.width*cover, backdropHeight=backdrop.height*cover;
    const groundY=oy+scale*332;
    const backdropY=clamp(groundY-backdropHeight*.58,h-backdropHeight,0);
    ctx.drawImage(backdrop,(w-backdropWidth)/2,backdropY,backdropWidth,backdropHeight);
    const shade=ctx.createLinearGradient(0,h*.48,0,h*.98);
    shade.addColorStop(0,'#121a1700');shade.addColorStop(.56,'#121a1748');shade.addColorStop(1,'#121a1773');
    ctx.fillStyle=shade;ctx.fillRect(0,h*.48,w,h*.52);
    ctx.translate(ox,oy);ctx.scale(scale,scale);
    const position=unit=>{
      const end=slot(unit.key,shown);
      if(!playing?.before||progress<contact||!motion)return end;
      const start=slot(unit.key,playing.before),t=clamp((progress-contact)/(rotating?beats.rotation-contact:280));
      const easing=rotating?rotationEase(t):t*t*(3-2*t);
      const arc=rotating&&start[0]!==end[0]?Math.sin(Math.PI*t)*Math.sign(end[0]-start[0])*38:0;
      return [mix(start[0],end[0],easing),mix(start[1],end[1],easing)+arc];
    };
    const roster=[...shown.heroes,...shown.battle.enemies];
    function paintActionLayer(layer){
      if(!motion)return;
      for(const effect of playing.effects??[]){
        if(effect.clip.layer!==layer)continue;
        const unit=roster.find(unit=>unit.key===effect.target);
        if(!unit)continue;
        const fallen=effect.key==='death';
        const [x,y]=fallen?slot(unit.key,playing.before):position(unit);
        const delay=fallen&&isBoss(unit)?bossDeathWindup:effect.delay;
        paintMotion(ctx,effect.clip,x,y-(layer==='ground'?0:isBoss(unit)?135:78),progress-resultAt-delay);
      }
    }
    paintActionLayer('ground');
    if(playing?.preview){
      const from=slot(playing.preview.actor,shown);
      strokeMark(...from,'#ecc783',39);
      for(const key of playing.preview.targets){
        const to=slot(key,shown);
        strokeMark(...to,'#f39a75',48);
        aim(from,to);
      }
    }
    if(motion&&progress<resultAt+150)strokeMark(...origin,'#ecc783',42,1-clamp((progress-resultAt)/150));
    if(shown.battle.lead&&!playing?.preview&&!['enemies','allies','traits','versus'].includes(lesson)){
      for(const team of [shown.heroes,shown.battle.enemies]){
        const lead=team.find(unit=>unit.hp&&!unit.bench);
        if(lead)strokeMark(...position(lead),team===shown.heroes?'#e9c37e':'#d7877f',isBoss(lead)?72:40,.82);
      }
    }
    for(const unit of roster.sort((a,b)=>position(a)[1]-position(b)[1])){
      if(unit.bench)continue;
      const enemy=isFoe(unit.key,shown);
      if(['enemies','versus'].includes(lesson)&&!enemy)continue;
      const active=motion&&striking&&event?.actor===unit.key;
      const boss=isBoss(unit);
      const [x,y]=position(unit);
      if(!reduced()&&unit.hp){
        paintMotion(ctx,combatMotion.spawn,x,y,now-(enemy?foeArrivalAt:arrivalAt));
        if(!enemy&&unit===shown.heroes.find(hero=>hero.hp&&!hero.bench))
          paintMotion(ctx,combatMotion.turnEnd,x,y,now-turnAt);
      }
      const fallen=!unit.hp;
      const died=fallen&&event&&playing.before.battle.enemies.some(old=>old.key===unit.key&&old.hp);
      const shatter=boss&&died&&progress>=resultAt;
      if(fallen&&!shatter)continue;
      ctx.save();
      const arrivalAge=now-(enemy?foeArrivalAt:arrivalAt);
      if(arrivalAge<620&&!reduced()){
        const amount=clamp(arrivalAge/440);
        ctx.globalAlpha=amount;
        ctx.translate(0,-21*(1-amount));
      }
      if(active&&!boss&&!combo&&targets[0]){
        const thrust=Math.max(0,1-Math.abs(progress-resultAt)/240);
        const range=event.key==='ranged'||unit.id==='tess'||stone?.04:enemy?.56:.32;
        ctx.translate((area[0]-origin[0])*range*thrust*thrust,(area[1]-origin[1])*range*thrust*thrust);
      }
      if(motion&&!shatter&&progress>=resultAt&&progress<resultAt+beats.reaction&&event.changes.some(change=>change.target===unit.key&&change.loss>0)){
        const rebound=(progress-resultAt)/beats.reaction;
        ctx.translate((enemy?1:-1)*Math.sin(Math.PI*rebound)*9,-Math.sin(Math.PI*rebound)*3);
      }
      if(!fallen){
        const shadowWidth=boss?112:enemy?61:36;
        ctx.save();
        ctx.translate(x,y-1);
        ctx.scale(1,.20);
        const shadow=ctx.createRadialGradient(0,0,shadowWidth*.13,0,0,shadowWidth);
        shadow.addColorStop(0,'rgba(18, 12, 15, .57)');
        shadow.addColorStop(1,'rgba(18, 12, 15, 0)');
        ctx.fillStyle=shadow;
        ctx.fillRect(-shadowWidth,-shadowWidth,shadowWidth*2,shadowWidth*2);
        ctx.restore();
      }
      if(shatter){
        const deathAge=progress-resultAt;
        const windup=reduced()?0:bossDeathWindup;
        if(deathAge<windup){
          const buildup=deathAge/windup;
          const clip=art[unit.id].idle;
          ctx.filter=`brightness(${1+buildup*.38})`;
          sprite(clip.image,clip.frames[0],x+Math.sin(deathAge*.12)*buildup*10,y,345);
        }else{
          const burst=deathAge-windup;
          const clip=art[unit.id].shatter;
          const index=clamp(Math.floor(burst/95),0,clip.frames.length-1);
          ctx.globalAlpha=1-clamp((burst-620)/250);
          sprite(clip.image,clip.frames[index],x,y,345);
        }
      }else if(art[unit.id]){
        const clip=art[unit.id][active?(combo?'combo':'attack'):'idle'];
        const frame=active?motionFrame(progress):reduced()?0:Math.floor(now/108)%clip.frames.length;
        sprite(clip.image,clip.frames[Math.min(frame,clip.frames.length-1)],x,y,boss?345:192);
      }else{
        const species=foes[unit.id].art;
        const frame=monsters.frames.find(frame=>frame.name===species);
        const quadruped=species==='Sap Runner';
        const period=quadruped?1080:1580;
        const breath=reduced()?0:Math.sin(now/period*(2*Math.PI)+x*.021);
        const windup=active?Math.sin(Math.PI*clamp(progress/resultAt)):0;
        const followThrough=active?Math.sin(Math.PI*clamp((progress-resultAt)/280)):0;
        const lean=breath*(quadruped?.019:.03)+windup*.105-followThrough*.09;
        ctx.translate(x,y);
        ctx.rotate(lean);
        const height=species==='The Grafted Bride'?245:179;
        sprite(art.monsters,frame,0,0,height*(1+breath*.024-windup*.04));
      }
      ctx.restore();
      if(!reduced()&&arrivalAge>=0&&arrivalAge<cinematic.spawn)drawArrival(x,y,arrivalAge);
      if(!fallen){
        label(unit,x,y,enemy);
      }
    }
    const pet=shown.battle.companion;
    const petOwner=pet&&shown.heroes.find(hero=>hero.key===pet.owner&&!hero.bench);
    if(petOwner&&art[pet.id]){
      const image=art[pet.id], [x,y]=position(petOwner);
      const summonAge=event?.type==='summon'?Math.max(0,progress-resultAt):Infinity;
      const casting=summonAge<380;
      const frame=casting?Math.min(3,Math.floor(summonAge/95)):reduced()?0:Math.floor(now/135)%4;
      const cellW=image.width/4,cellH=image.height/2;
      const size=portrait()?73:78;
      ctx.save();
      ctx.globalAlpha=reduced()?1:clamp(summonAge/180);
      ctx.drawImage(image,frame*cellW,casting?cellH:0,cellW,cellH,x+23,y-size+7,size,size);
      ctx.restore();
    }
    if(bossAction&&event&&progress>=contact-190){
      drawEncounterEffect(ctx,bossEffects,{sequence:combo?(targets.length>2?3:1):0,
        targets:targets.map(key=>slot(key,shown)),origin,age:(progress-contact)/1000,reduced:reduced(),
        color:encounterActions[foes[attacker.id].art].color});
    }
    const intercepts=event?.changes.filter(change=>change.covered).map(change=>change.target)??[];
    const effectId=intercepts.length?'cover':event?.art;
    if(effectId&&art[effectId]&&progress>=contact-120&&progress<1180){
      const effect=art[effectId];
      const elapsed=Math.max(0,Math.floor((progress-contact+120)/90));
      const frame=intercepts.length?4+Math.min(3,elapsed):Math.min(effectId==='cover'?3:7,elapsed);
      for(const key of intercepts.length?intercepts:affected){
        const unit=[...shown.heroes,...shown.battle.enemies].find(unit=>unit.key===key);
        if(!unit||!unit.hp&&!intercepts.includes(key))continue;
        const [x,y]=position(unit), rect=effect.frames[frame], size=effectId==='brace'?144:111;
        ctx.globalAlpha=1-clamp((progress-1020)/160);
        ctx.drawImage(effect.image,...rect,x-size/2+(intercepts.length?30:0),y-size*(effect.grounded?effect.baselines[frame]:.98),size,size);
        ctx.globalAlpha=1;
      }
    }
    const contactAge=progress-contact;
    const showStrike=event?.side==='party'&&event.type!=='summon'&&!event.art&&targets.length>0&&
      (event.changes.some(change=>change.loss!==undefined)||['red-thread','mending-note'].includes(event.key));
    if(showStrike&&!stone&&contactAge>=0&&contactAge<485){
      const [file,row,count]=hitArt(event.actor,event.key);
      const image=art[file],fw=image.width/4,fh=image.height/hitSheets[file];
      const frame=Math.min(count-1,Math.floor(contactAge/(count===8?62:93)));
      const index=row*4+frame;
      ctx.globalAlpha=1-clamp((contactAge-270)/215);
      for(const key of targets){
        const unit=[...shown.heroes,...shown.battle.enemies].find(unit=>unit.key===key);
        const [x,y]=unit?position(unit):slot(key,shown),size=event.key==='undertow'?184:145;
        ctx.drawImage(image,index%4*fw,Math.floor(index/4)*fh,fw,fh,x-size/2,y-size+13,size,size);
      }
      ctx.globalAlpha=1;
    }
    if(stone&&contactAge>=-330&&contactAge<625){
      const image=art['rook-stonefall.png'];
      const w=image.width/4,h=image.height/2;
      const [x,y]=area;
      const stamp=(i,dx,dy,sw,sh)=>ctx.drawImage(image,i%4*w,Math.floor(i/4)*h,w,h,x+dx-sw/2,y+dy-sh,sw,sh);
      const burst=contactAge-260;
      ctx.globalAlpha=1-clamp((burst-160)/205);
      for(let i=0;i<3;i++){
        const drop=clamp((contactAge+330-i*30)/330);
        if(drop>0&&!reduced())stamp(i,(i-1)*36,-140*(1-drop*drop),70,106-i*10);
      }
      if(contactAge>=0)stamp(3,0,6,155,65);
      if(burst>=0)stamp(4+Math.min(3,Math.floor(burst/78)),0,16,182,155);
      ctx.globalAlpha=1;
    }
    paintActionLayer('front');
    if(battleVfx===undefined)battleVfx=createBattleVfx();
    if(battleVfx){
      const clock=reduced()?0:now/1000;
      const age=progress-resultAt;
      const positions=new Map(roster.map(unit=>[unit.key,unit]));
      for(const unit of roster){
        if(!unit.hp||unit.bench)continue;
        const enemy=isFoe(unit.key,shown);
        if(!enemy&&['enemies','versus'].includes(lesson))continue;
        const [x,y]=position(unit);
        const large=isBoss(unit);
        if(unit.curseSources?.some(source=>source.tier>0)){
          battleVfx.stamp(2,x,y-(large?135:77),large?245:143,large?260:172,'#b659df',clock,.78);
        }
      }
      if(event&&age>=0&&age<420){
        const impact=clamp(age/420);
        for(const key of targets){
          const unit=positions.get(key);
          if(!unit)continue;
          const change=event.changes.find(entry=>entry.target===key);
          const [x,y]=position(unit);
          const large=isBoss(unit);
          const defending=event.type==='guard'||event.type==='ward';
          if(defending||change?.blocked){
            const shieldX=x+(isFoe(unit.key,shown)?-1:1)*(large?85:37);
            const expand=1+impact*.22;
            battleVfx.stamp(0,shieldX,y-(large?136:73),(large?102:60)*expand,(large?130:77)*expand,
              event.type==='ward'?'#51c6b1':'#91dfff',clock,1-impact,impact);
          }else if(event.key==='curse'&&change?.changed){
            battleVfx.stamp(2,x,y-(large?135:77),large?280:180,large?290:190,'#de8df8',clock,1-impact);
          }else if(striking&&!change?.evaded){
            const color=stone?'#f1b071':/undertow|oarhook/.test(event.key)?'#7ce3dc':
              /seam|thorn/.test(event.key)?'#e66a62':/chime|bell/.test(event.key)?'#c7a4ff':
              bossAction?encounterActions[foes[attacker.id].art].color:'#edbf83';
            const size=large?198:combo?158:126;
            battleVfx.stamp(3,x,y-(large?132:81),size,size*.84,color,clock,.94*(reduced()?1-impact:1),reduced()?.26:impact,
              event.side==='party'?0:Math.PI);
            if(!reduced()&&!large&&change?.loss>0&&(combo||stone||event.key==='final-delivery')){
              battleVfx.stamp(1,x,y-168,94,40,'#f9d569',clock,1-impact);
            }
          }
        }
      }
      battleVfx.draw(ctx);
    }
    if(event&&progress>=resultAt&&progress<resultAt+650){
      const drift=clamp((progress-resultAt)/650);
      const still=reduced();
      const rowsByTarget=new Map();
      ctx.save();
      ctx.globalAlpha=1-clamp((drift-.67)/.33);
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.strokeStyle='#241615';
      ctx.lineJoin='round';
      for(const change of event.changes){
        const unit=roster.find(unit=>unit.key===change.target);
        const [x,y]=unit?position(unit):slot(change.target,shown);
        let text,color;
        if(change.blocked){
          text='BLOCKED';color='#aee6f4';
        }else if(change.evaded){
          text='DODGED';color='#f6e2ab';
        }else if(change.loss>0){
          text='+'+change.loss+' DMG';color='#ff9a7b';
        }else if(change.absorbed>0){
          text='ABSORBED';color='#aee6f4';
        }else{
          const gain=change.text?.match(/ \+(\d+(?:\.\d+)?) (HP|Defense)\b/);
          if(!gain||Number(gain[1])===0)continue;
          text='+'+gain[1]+(gain[2]==='HP'?' HP':' DEF');
          color=gain[2]==='HP'?'#a4e8a1':'#aee6f4';
        }
        const row=rowsByTarget.get(change.target)??0;
        rowsByTarget.set(change.target,row+1);
        const flyY=y-(isBoss(unit)?151:101)-row*30-(still?0:34*drift);
        const pop=still?1:1+.2*Math.sin(Math.PI*clamp(drift/.27));
        const size=(change.loss>0&&!change.blocked&&!change.evaded?29:23)*pop;
        ctx.font=size+'px "Bubblegum Sans", system-ui';
        ctx.lineWidth=5;
        ctx.fillStyle=color;
        ctx.strokeText(text,x,flyY);
        ctx.fillText(text,x,flyY);
      }
      ctx.restore();
    }
    if(current.battle)tick=requestAnimationFrame(draw);
  }

  return {
    show,
    revealAllies(){arrivalAt=performance.now();cue(combatMotion.spawn.sound);},
    revealEncounter(){arrivalAt=foeArrivalAt=performance.now();cue('foe-arrival');},
    endTurn(){turnAt=performance.now();cue(combatMotion.turnEnd.sound);},
    projectUnit(key,state){
      const {x,y,scale}=layout();
      const [sx,sy]=slot(key,state);
      const unit=state.battle.enemies.find(unit=>unit.key===key);
      const boss=isBoss(unit);
      const height=Math.max(52,(boss?260:unit?160:175)*scale);
      const width=Math.max(40,(boss?285:unit?155:106)*scale);
      return {x:x+sx*scale-width/2,y:y+(sy+45)*scale-height,width,height};
    },
    project(key,state){
      const {x,y,scale}=layout();
      const [sx,sy]=slot(key,state);
      return [x+sx*scale,y+(sy+46)*scale+18];
    },
    preview(actor,targets){
      if(playing?.result)return;
      playing={preview:{actor,targets},started:0};
    },
    clearPreview(){if(!playing?.result)playing=null;},
    async play(before,state,result){
      current=state;
      const speed=settings.speed;
      const effects=actionEffects(result,before,state);
      const playback={before,result,started:performance.now(),speed,effects};
      playing=playback;
      const centered=result.type==='guard'||result.key==='idle';
      flash.classList.toggle('centered-action-flash',centered);
      flash.textContent=result.type==='guard'?'GUARD':centered?result.name.toUpperCase():result.name;
      const bossKey=state.battle.enemies.find(isBoss)?.key;
      const bossFell=effects.some(entry=>entry.key==='death'&&entry.target===bossKey);
      const stone=result.key==='stone-answer';
      const contactTime=impactAt(result.key);
      const normalDuration=result.type==='rotate'?beats.rotation:stone?1380:1180;
      const tail=effects.reduce((end,entry)=>Math.max(end,entry.delay+entry.clip.duration),0);
      const duration=bossFell?contactTime+(reduced()?870:bossDeathWindup+combatMotion.death.duration):
        reduced()?contactTime+260:Math.max(normalDuration,contactTime+tail);
      const sounds=new Map();
      for(const {key,clip,delay,target} of effects){
        const offset=key==='death'?(bossFell&&target===bossKey?bossDeathWindup:220):delay;
        if(!sounds.has(offset))sounds.set(offset,new Set());
        sounds.get(offset).add(clip.sound);
      }
      const timers=[...sounds].map(([delay,impacts])=>setTimeout(()=>{
        if(playing!==playback)return;
        const actor=[...before.heroes,...before.battle.enemies].find(unit=>unit.key===result.actor);
        const defended=impacts.has('break')||impacts.has('dodge')||impacts.has('miss');
        const played=delay===0&&!defended&&cueAttack(result.key,actor?.id,result.side,state.battle.companion?.id,speed);
        for(const sound of impacts){
          if(played&&['hit','ui-choice','guard','heal','cleanse'].includes(sound))continue;
          cue(sound,speed);
        }
      },(contactTime+delay)/speed));
      await new Promise(resolve=>setTimeout(resolve,duration/speed));
      timers.forEach(clearTimeout);
      if(playing!==playback)return;
      playing=null;
      flash.textContent='';
      flash.classList.remove('centered-action-flash');
    },
    stop(){
      current=null;ready=false;arenaFile=null;playing=null;queued++;
      flash.classList.remove('centered-action-flash');
      arrivalAt=-Infinity;
      foeArrivalAt=-Infinity;
      turnAt=-Infinity;
      if(tick)cancelAnimationFrame(tick);
      tick=0;
      delete canvas.dataset.arena;
      ctx.setTransform(1,0,0,1,0,0);
      ctx.clearRect(0,0,canvas.width,canvas.height);
    },
  };
}
