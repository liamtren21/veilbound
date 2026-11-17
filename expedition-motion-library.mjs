// Presentation only. The resolver owns damage, dice, rewards and progression.
const effect=(duration,shape,color,sound,layer='front')=>Object.freeze({duration,shape,color,sound,layer});
export const combatMotion=Object.freeze({
  damage:effect(340,'burst','#f3bc83','hit'),
  critical:effect(450,'burst','#ffe2a1','critical'),
  heal:effect(600,'rise','#a5e1a8','heal'),
  buff:effect(600,'rise','#e9c275','buff'),
  debuff:effect(600,'sink','#c590ba','debuff'),
  miss:effect(350,'streak','#bbb9b2','miss'),
  generic:effect(420,'ring','#ded2a8','ui-choice','ground'),
  guardOn:effect(350,'shield','#91c8ce','guard'),
  guardOff:effect(470,'shield','#c0e1df','break'),
  dodge:effect(800,'streak','#a7d6c5','dodge'),
  focus:effect(600,'ring','#ffe091','buff','ground'),
  spawn:effect(1500,'rise','#d6dcad','spawn','ground'),
  turnEnd:effect(500,'ring','#e1c18c','turn','ground'),
  death:effect(1000,'ash','#c2aa9d','fall'),
  relentlessOff:effect(600,'burst','#ee925e','break'),
  purification:effect(600,'rise','#c6f2e7','cleanse'),
  revive:effect(900,'rise','#efdf9e','revive'),
  blame:effect(600,'sink','#d66d74','curse'),
});
export const damageMotion=Object.freeze({
  claw:effect(310,'claw','#ebbb93','hit'),
  slash:effect(300,'slash','#ecc88e','hit'),
  blackMagic:effect(410,'ring','#ae86bc','debuff'),
  leaf:effect(380,'leaf','#bbca80','hit'),
  bite:effect(310,'bite','#e8ad89','hit'),
  fire:effect(440,'rise','#f29551','critical'),
  thunder:effect(300,'bolt','#c9d6ff','critical'),
  ice:effect(450,'leaf','#a7e0f2','hit'),
  bludgeon:effect(390,'burst','#d9ae7b','hit'),
  psychic:effect(460,'ring','#a5b4df','debuff'),
});
export const beats=Object.freeze({
  contact:560, stoneContact:820, reaction:200, rotation:1300,
  sceneIn:500, sceneOut:750, lootFlight:500, lootReceive:350,
  routeMin:330, routeMax:850, rollSpinMin:350, rollSpinRange:400,
  rollSettleMin:250, rollSettleRange:250, rollStagger:22, rollBurst:260,
  settleEase:'cubic-bezier(.215,.61,.355,1)', travelEase:'ease-in-out',
});
export const impactAt=key=>key==='stone-answer'?beats.stoneContact:beats.contact;
const damageByAction={
  rake:'claw',lunge:'bite',thorn:'leaf',pierce:'leaf',pull:'leaf',root:'leaf',
  sweep:'claw',siege:'blackMagic',strike:'slash',undertow:'psychic',
  'open-seam':'slash','stone-answer':'bludgeon','fracture-chime':'psychic',
  'pin-hem':'leaf','iron-needle':'slash','final-delivery':'slash',
  'anchor-lash':'bludgeon','chain-sweep':'slash','drowned-surge':'psychic',
  'furnace-snap':'bite','vent-burst':'fire','consume-heat':'fire',
  'blade-rake':'claw','front-car-rake':'slash','final-toll':'thunder',
  'gravestone-claw':'claw','stay-verdict':'bludgeon','move-verdict':'bludgeon','stone-decree':'bludgeon',
};
const units=state=>[...state.heroes,...state.battle.enemies];

export function actionEffects(result,before,after){
  const previous=new Map(units(before).map(unit=>[unit.key,unit]));
  const current=new Map(units(after).map(unit=>[unit.key,unit]));
  const effects=[];
  const add=(key,target,delay=0,flavor)=>effects.push({
    key,target,delay,clip:flavor?damageMotion[flavor]:combatMotion[key],flavor,
  });
  for(const change of result.changes){
    const {target,loss,blocked,evaded,absorbed,survived}=change;
    if(blocked)add('guardOff',target);
    else if(evaded)add('dodge',target);
    else if(loss>0){
      const move=['hit','pull'].includes(result.type);
      add(change.critical?'critical':'damage',target,0,move&&!change.critical?damageByAction[result.key]:undefined);
    }else if(absorbed)add('guardOff',target);
    else if(loss===0)add('miss',target);
    if(survived)add('relentlessOff',target,130);
  }
  for(const [key,unit] of current){
    const old=previous.get(key);
    if(!old)continue;
    if(unit.hp<1&&old.hp>0){add('death',key,90);continue;}
    if(unit.hp>0&&old.hp<1)add('revive',key);
    else if(unit.hp>old.hp)add('heal',key);
    if(unit.guard&&!old.guard)add('guardOn',key);
    if(unit.ward>old.ward||(unit.boost??0)>(old.boost??0)||unit.atk>old.atk||unit.cover&&!old.cover)add('buff',key);
    if(unit.focus&&!old.focus)add('focus',key);
    if(['bleed','rooted','weak','mark','frozen'].some(status=>(unit[status]??0)>(old[status]??0))){
      const hit=effects.some(effect=>effect.target===key&&['damage','critical'].includes(effect.key));
      add('debuff',key,hit?130:0);
    }
    if(result.type==='cleanse'&&result.targets.includes(key))add('purification',key);
  }
  if(!effects.length&&result.actor)add('generic',result.actor);
  return effects;
}

// Sample the authored overshoot curve at normalized time.
const rotationKeys=[[0,0],[.154,1.052],[.237,.979],[.342,1.011],[1,1]];
export function rotationEase(t){
  const next=rotationKeys.findIndex(([time])=>time>t);
  if(next<1)return t>=1?1:0;
  const [start,from]=rotationKeys[next-1], [end,to]=rotationKeys[next];
  const x=(t-start)/(end-start);
  return from+(to-from)*(x*x*(3-2*x));
}

export function paintMotion(ctx,clip,x,y,age){
  if(age<0||age>=clip.duration)return;
  const t=age/clip.duration;
  const out=1-(1-t)**3;
  ctx.save();
  ctx.translate(x,y);
  ctx.globalAlpha*=Math.min(1,t*9)*(1-t)**1.45;
  ctx.strokeStyle=ctx.fillStyle=clip.color;
  ctx.lineWidth=3*(1-t)+1;
  ctx.lineCap='round';
  const radius=13+out*42;
  switch(clip.shape){
    case 'ring':
      ctx.beginPath();
      ctx.ellipse(0,0,radius,radius*.33,0,0,Math.PI*2);
      ctx.stroke();
      break;
    case 'shield':
      ctx.beginPath();
      ctx.moveTo(-20,-18);ctx.quadraticCurveTo(0,-28,20,-18);
      ctx.quadraticCurveTo(19,8,0,22);ctx.quadraticCurveTo(-19,8,-20,-18);
      ctx.stroke();
      break;
    case 'slash':
    case 'claw':
    case 'streak':
      for(let i=0;i<(clip.shape==='claw'?3:2);i++){
        ctx.beginPath();
        ctx.moveTo(-radius,i*10+radius*.55);
        ctx.quadraticCurveTo(radius*.3,i*10+7,radius,i*10-radius*.62);
        ctx.stroke();
      }
      break;
    case 'bolt':
      ctx.beginPath();ctx.moveTo(-9,-radius);ctx.lineTo(8,-12);ctx.lineTo(-8,3);ctx.lineTo(10,radius);ctx.stroke();
      break;
    case 'bite':
      for(const side of [-1,1]){
        const opening=side*(5+27*(1-out));
        ctx.beginPath();
        for(let i=0;i<9;i++)ctx.lineTo((i-4)*7,opening+side*(i%2?-8:Math.abs(i-4)));
        ctx.stroke();
      }
      break;
    default:
      for(let i=0;i<10;i++){
        const angle=i*2.39996, spread=radius*(.55+(i%4)*.12);
        const px=Math.cos(angle)*spread;
        const drift=clip.shape==='rise'||clip.shape==='ash'?-out*50:clip.shape==='sink'?out*27:0;
        const py=Math.sin(angle)*spread*.72+drift;
        ctx.beginPath();
        if(clip.shape==='leaf'||clip.shape==='ash'){
          ctx.moveTo(px,py-5);ctx.lineTo(px+4,py);ctx.lineTo(px,py+7);ctx.lineTo(px-3,py);ctx.fill();
        }else{
          ctx.moveTo(px*.8,py*.8);ctx.lineTo(px,py);ctx.stroke();
        }
      }
  }
  ctx.restore();
}
