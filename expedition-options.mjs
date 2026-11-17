import { attackCue, playSfx, preloadSfx } from './expedition-sfx.mjs?v=2';
const key='veilbound-options-v1';
const defaults={master:80,effects:85,music:50,resolution:100,motion:false,speed:1};
let saved={};
try{saved=JSON.parse(localStorage.getItem(key))??{};}catch{}
export const settings={...defaults,motion:matchMedia('(prefers-reduced-motion: reduce)').matches,...saved};
export function applySettings(changes){
  Object.assign(settings,changes);
  syncMusic();
  try{localStorage.setItem(key,JSON.stringify(settings));}catch{}
  document.body.classList.toggle('reduce-motion',settings.motion);
  document.body.classList.toggle('fast-combat',settings.speed===3);
  const control=document.querySelector('#reduced');if(control)control.checked=settings.motion;
}
export const resetSettings=()=>applySettings(defaults);

let context;
export function cue(name,speed=1){
  const volume=settings.master*settings.effects*.00005;
  playSfx(context,name,volume,speed);
}
export function cueAttack(key,actor,side,companionId,speed=settings.speed){
  const name=attackCue(key,actor,side,companionId);
  if(!name)return false;
  cue(name,speed);
  return true;
}
const musicFiles={
  menu:'The_Sunken_Threshold.mp3',
  expedition:'Beneath_the_Hollow_Orchard.mp3',
  boss:'Threshold_of_the_Drowned.mp3',
};
let musicScene='menu';
let musicEnabled=true;
let musicUnlocked=false;
let musicPlayer;

export function setMusicScene(scene){
  if(scene===musicScene)return;
  musicScene=scene;
  syncMusic();
}

export function setMusicEnabled(enabled){
  musicEnabled=enabled;
  syncMusic();
}

function syncMusic(){
  const volume=Math.min(1,Math.max(0,settings.master*settings.music/10000));
  if(!musicUnlocked||!musicEnabled||document.hidden||!volume){
    musicPlayer?.pause();
    return;
  }
  if(!musicPlayer){
    musicPlayer=new Audio();
    musicPlayer.loop=true;
  }
  const source=new URL('./combat-assets/music-v1/'+musicFiles[musicScene],import.meta.url).href;
  if(musicPlayer.src!==source)musicPlayer.src=source;
  musicPlayer.volume=volume;
  if(musicPlayer.paused)void musicPlayer.play().catch(()=>{});
}

function unlockMusic(event){
  if(!event.isTrusted)return;
  musicUnlocked=true;
  syncMusic();
}
document.addEventListener('visibilitychange',syncMusic);
document.addEventListener('pointerup',unlockMusic,{passive:true});
document.addEventListener('keydown',unlockMusic,{passive:true});
function enableSound(){
  const Audio=window.AudioContext??window.webkitAudioContext;
  if(!Audio)return;
  try{
    if(!context){context=new Audio();preloadSfx(context);}
    if(context.state!=='running')void context.resume().catch(()=>{});
  }catch{}
}
document.addEventListener('pointerdown',enableSound,{passive:true});
document.addEventListener('keydown',enableSound,{passive:true});
document.addEventListener('click',event=>{
  const control=event.target.closest?.('button, a[href], [role="button"], summary');
  if(!control||control.matches(':disabled,[aria-disabled="true"]'))return;
  enableSound();
  const explicit=control.dataset.sfx;
  if(explicit){cue(explicit);return;}
  if(control.matches('.node,.loot-row,.reward-item'))return;
  if(control.matches('.die,.mode-action')){
    const side=control.classList.contains('foe')||control.dataset.side==='foe'?'foe':'party';
    cue(control.dataset.state==='blocked'?'dice-blocked':'dice-select-'+side);
    return;
  }
  if(control.matches('.mode-target, #target-layer button, .loot-recipient')){cue('target-lock');return;}
  if(control.matches('#reroll,#end-round'))return;
  if(control.matches('summary,#settings')){cue('ui-open');return;}
  if(control.matches('nav a,[role="tab"]')){cue('ui-tab');return;}
  if(control.matches('dialog button[value="cancel"]')){cue('ui-cancel');return;}
  if(control.matches('dialog button[value="confirm"], .resolve-action')){cue('ui-confirm');return;}
  if(control.matches('.story-choice,.story-inspect')){cue('ui-choice');return;}
  cue('ui-click');
},{capture:true});
