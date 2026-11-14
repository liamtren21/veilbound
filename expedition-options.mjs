const key='veilbound-options-v1';
const defaults={master:80,effects:85,music:50,resolution:100,motion:false,speed:1};
let saved={};
try{saved=JSON.parse(localStorage.getItem(key))??{};}catch{}
export const settings={...defaults,motion:matchMedia('(prefers-reduced-motion: reduce)').matches,...saved};
export function applySettings(changes){
  Object.assign(settings,changes);
  try{localStorage.setItem(key,JSON.stringify(settings));}catch{}
  document.body.classList.toggle('reduce-motion',settings.motion);
  document.body.classList.toggle('fast-combat',settings.speed===3);
  const control=document.querySelector('#reduced');if(control)control.checked=settings.motion;
}
export const resetSettings=()=>applySettings(defaults);

let context;
function note(frequency,delay,seconds,volume){
  if(!context||context.state!=='running'||volume<=0)return;
  const time=context.currentTime+delay;
  const wave=context.createOscillator();const gain=context.createGain();
  wave.type='sine';wave.frequency.value=frequency;
  gain.gain.setValueAtTime(.0001,time);
  gain.gain.exponentialRampToValueAtTime(volume,time+.025);
  gain.gain.exponentialRampToValueAtTime(.0001,time+seconds);
  wave.connect(gain).connect(context.destination);wave.start(time);wave.stop(time+seconds+.03);
}
const patterns={
  select:[440],roll:[210,286,360],rollFast:[286,420],reroll:[310,230,395],
  hit:[115,82],critical:[165,110,73],guard:[325,490],break:[510,275,135],
  dodge:[495,360],heal:[294,440,587],buff:[392,523],debuff:[246,185],
  cleanse:[392,523,784],spawn:[220,330,440],fall:[196,130,98],
  loot:[523,659,784],route:[196,247],turn:[392,587],win:[293,392,587],
};
export function cue(name,speed=1){
  const pattern=patterns[name];
  if(!pattern)return;
  pattern.forEach((frequency,index)=>note(frequency,index*.07/speed,.16,settings.master*settings.effects*.000004));
}
let bar=0;
let musicEnabled=true;
export function setMusicEnabled(enabled){musicEnabled=enabled;}
document.addEventListener('pointerdown',()=>{
  const Audio=window.AudioContext??window.webkitAudioContext;
  if(!Audio)return;
  try{context??=new Audio();void context.resume().catch(()=>{});}catch{}
},{passive:true});
setInterval(()=>{
  if(document.hidden||!musicEnabled)return;
  const chord=[[110,165,220],[98,147,196],[87,131,175],[98,147,196]][bar++%4];
  chord.forEach((frequency,index)=>note(frequency,index*.22,2.6,settings.master*settings.music*.0000015));
},3200);
