import {heroes,nodes} from './expedition-data.mjs';
import {openTitleLogin,requestTitleAuth,titleAuthenticated} from './expedition-title-auth.mjs?v=menu-session-v1';
import {applySettings,resetSettings,settings,cue,setMusicEnabled,setMusicScene} from './expedition-options.mjs?v=sfx-v2';
import {cinematic} from './expedition-cinematics.mjs';
import {paintDiceFace} from './expedition-dice-paint.mjs?v=oar-v22';
import {freshProgress,settleRun,talismanStats,talismanUnlocked,talismans,xpRewards} from './expedition-progression.mjs';
const PROFILE='veilbound-profile-v1';
const shots=[
  ['orchard-expedition-panorama-v2.png','The Accord once carried the dead beyond the Quiet Reach.',8500],
  ['wood-resin-creek-v1.png','When the Waymarks began to fail, the keepers fed them stolen memories.',8500],
  ['wood-doorless-house-v1.png','In Hollow Orchard, the roots remember a village that never came home.',8500],
  ['wood-closed-doors-sanctum-v1.png','Every door still waits for someone.',6000],
  ['wood-orchard-threshold-v1.png','ROOK: We carry their names. That is all they asked of us.',7500],
  ['wood-orchard-threshold-v1.png','MARA: Then let’s make sure the orchard hears them.',6800],
];
export const lessonPages=[
  ['versus','Battle Start'],
  ['enemies','Those are the Bark Listener and Sap Runner. The orchard has sent them to stop us.'],
  ['allies','Here are your wardens. Their skills change with whoever stands at the front.'],
  ['traits','Rook’s Guard stops the next direct attack. Mara’s Undertow pulls a smaller enemy toward the front.'],
  ['leads','The two units facing each other are the leads. They act for their squads.'],
  ['ready','Your lead is ready to act. Change positions to use a different warden.'],
  ['light','The light dice command your wardens.'],
  ['dark','The dark dice command the beasts.'],
  ['controls','Use either side’s dice in any order. A face with a choice asks you to pick a target.'],
];
const quickLessonPages=[
  ['versus','Battle Start'],
  ['controls','Light dice command your wardens. Dark dice command enemies. Resolve either side in any order.'],
];
export function lessonPage(state){
  if(state.node!=='road'||state.phase!=='battle')return null;
  const index=state.tutorial?.introPage;
  if(!state.tutorial?.enabled&&index!==0)return null;
  const pages=state.tutorial?.quick?quickLessonPages:lessonPages;
  return Number.isInteger(index)?pages[index]??null:null;
}

export function createJourney({leaveBattle,getState,saveRun,newJourney,resume,hasSave,isBusy,reduced,wardenPreview,deleteSave}){
  let profile;
  try{profile=JSON.parse(localStorage.getItem(PROFILE));}catch{}
  if(profile?.version!==1)profile={version:1,openingSeen:false,tutorialDone:false};
  if(!['intro','video'].includes(profile.combatLesson))profile.tutorialDone=false;
  profile.progress??=freshProgress();
  const writeProfile=()=>{try{localStorage.setItem(PROFILE,JSON.stringify(profile));}catch{}};
  const main=document.querySelector('main');
  const loading=document.getElementById('title-loading');
  const titleLogo=document.getElementById('boot-logo');
  const titleArt=new Image();
  titleArt.className='title-backdrop';
  titleArt.alt='';
  titleArt.src='combat-assets/veilbound-title-waymark-v2.webp';
  const overlay=document.createElement('section');
  overlay.className='journey-screen';overlay.hidden=true;
  overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');
  const coach=document.createElement('aside');coach.className='journey-coach';coach.hidden=true;
  coach.setAttribute('aria-label','Field guidance');
  const spotlight=el('div','','lesson-spotlight');spotlight.hidden=true;
  spotlight.setAttribute('aria-hidden','true');
  spotlight.innerHTML=`<svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="lesson-feather" x="-40%" y="-65%" width="180%" height="230%"><feGaussianBlur stdDeviation="12"/></filter>
    <mask id="lesson-window" x="0" y="0" width="100%" height="100%" maskUnits="userSpaceOnUse">
      <rect width="100%" height="100%" fill="white"/><rect class="lesson-hole" fill="black" rx="12" filter="url(#lesson-feather)"/>
    </mask></defs><rect width="100%" height="100%" fill="#090d0b" fill-opacity=".80" mask="url(#lesson-window)"/>
  </svg>`;
  const hole=spotlight.querySelector('.lesson-hole');
  document.body.append(overlay,spotlight,coach);
  document.addEventListener('pointerdown',()=>{overlay.dataset.input='pointer';},true);
  document.addEventListener('keydown',event=>{
    if(!event.altKey&&!event.ctrlKey&&!event.metaKey)delete overlay.dataset.input;
  },true);
  let timer,returnFocus,mode,versusTimer;
  let focusTarget=null,allowedSelector=null;
  function positionSpotlight(){
    if(!focusTarget)return;
    const width=window.innerWidth,height=window.innerHeight;
    const rect=typeof focusTarget==='string'?document.querySelector(focusTarget)?.getBoundingClientRect():null;
    if(typeof focusTarget==='string'&&!rect)return;
    const [x,y,w,h]=rect?[rect.x-12,rect.y-12,rect.width+24,rect.height+24]:
      [focusTarget[0]*width,focusTarget[1]*height,focusTarget[2]*width,focusTarget[3]*height];
    for(const [key,value] of Object.entries({x,y,width:w,height:h}))hole.setAttribute(key,value);
  }
  function illuminate(target,allowed=''){
    focusTarget=target;
    allowedSelector=allowed;
    positionSpotlight();
    spotlight.hidden=false;
  }
  window.addEventListener('resize',positionSpotlight);
  document.addEventListener('scroll',positionSpotlight,true);
  const allowed=target=>coach.contains(target)||(allowedSelector&&target.closest?.(allowedSelector));
  for(const type of ['pointerdown','click','contextmenu'])document.addEventListener(type,event=>{
    if(allowedSelector===null||!overlay.hidden||event.target.closest?.('dialog[open]'))return;
    if(allowed(event.target)){
      if(type==='click'&&coach.dataset.page==='route-click'&&event.target.closest('#nodes .reachable'))finishTutorial();
      return;
    }
    event.preventDefault();event.stopImmediatePropagation();
  },true);
  document.addEventListener('keydown',event=>{
    if(allowedSelector===null||!overlay.hidden||document.querySelector('dialog[open]'))return;
    if(event.key==='Tab'){
      const choices=[...document.querySelectorAll('button:not(:disabled),summary,[tabindex="0"]')]
        .filter(control=>allowed(control)&&control.getClientRects().length&&getComputedStyle(control).visibility==='visible');
      if(!choices.length)return;
      const current=choices.indexOf(document.activeElement);
      const next=current===-1?(event.shiftKey?choices.at(-1):choices[0]):choices[(current+(event.shiftKey?-1:1)+choices.length)%choices.length];
      event.preventDefault();next.focus();
    }else if(event.key==='Escape'||!allowed(event.target)){
      event.preventDefault();event.stopImmediatePropagation();
    }
  },true);
  function el(tag,text,className){const e=document.createElement(tag);e.textContent=text??'';if(className)e.className=className;return e;}
  function btn(text,fn){const b=el('button',text);b.type='button';b.onclick=fn;
    if(/^(Back|Resume|Quit|Cancel)$/.test(text))b.dataset.sfx='ui-back';
    else if(/^(Start|New Game|Continue)$/.test(text))b.dataset.sfx='ui-confirm';
    else if(/^(Options|Settings|Account|Compendium)$/.test(text))b.dataset.sfx='ui-open';return b;}
  function speech(text,advance){
    let complete=reduced();
    const button=btn('',()=>{
      if(!complete){complete=true;copy.textContent=text;return;}
      if(button.disabled)return;
      button.disabled=true;
      if(reduced()){advance();return;}
      const fade=coach.animate([{opacity:1},{opacity:0}],{duration:cinematic.tutorialOut,fill:'forwards'});
      if(!spotlight.hidden)spotlight.animate([{opacity:1},{opacity:0}],{duration:cinematic.tutorialOut});
      void fade.finished.then(()=>{fade.cancel();if(button.isConnected)advance();});
    });
    const copy=el('span',complete?text:'','dialogue-copy');
    const marker=el('span',' ▾','dialogue-chevron');marker.setAttribute('aria-hidden','true');
    button.append(copy,marker);
    button.setAttribute('aria-label','Advance dialogue: '+text);
    if(!complete){
      const start=performance.now();
      const type=now=>{
        if(complete||!button.isConnected)return;
        const count=Math.floor((now-start)*.063);
        copy.textContent=text.slice(0,count);
        complete=count>=text.length;
        if(!complete)requestAnimationFrame(type);
      };
      requestAnimationFrame(type);
    }
    return button;
  }
  function show(label){
    clearTimeout(timer);returnFocus=document.activeElement;overlay.hidden=false;main.inert=true;coach.hidden=true;spotlight.hidden=true;
    overlay.classList.remove('journey-title','journey-starter','journey-account','journey-compendium','journey-pause');
    overlay.setAttribute('aria-label',label);overlay.replaceChildren();
  }
  function updateJourneyMusic(){
    const run=getState();
    setMusicScene(run.phase==='battle'&&nodes.some(node=>node.id===run.node&&node.type==='boss')?'boss':'expedition');
  }
  function close(){
    clearTimeout(timer);overlay.hidden=true;main.inert=false;mode=null;returnFocus?.focus?.();refresh();
    updateJourneyMusic();
  }
  overlay.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&mode==='opening'){e.preventDefault();overlay.querySelector('[data-skip]')?.click();}
    if(e.key==='Escape'&&mode==='account'){e.preventDefault();leaveAccount();}
    if(e.key!=='Tab')return;
    const buttons=[...overlay.querySelectorAll('button:not(:disabled)')];
    if(!buttons.length)return;
    if(e.shiftKey&&document.activeElement===buttons[0]){e.preventDefault();buttons.at(-1).focus();}
    else if(!e.shiftKey&&document.activeElement===buttons.at(-1)){e.preventDefault();buttons[0].focus();}
  });
  function opening(done){
    show('Hollow Orchard — opening');mode='opening';let index=0;
    const finish=()=>{clearTimeout(timer);profile.openingSeen=true;writeProfile();close();done?.();};
    function paint(){
      clearTimeout(timer);const [file,text,duration]=shots[index];
      overlay.style.backgroundImage='none';
      overlay.replaceChildren();
      const frame=el('div','','opening-frame');
      frame.style.backgroundImage=`url("combat-assets/${file}")`;
      const caption=el('div','','opening-caption');
      const subtitle=el('p',text);caption.append(subtitle);
      const controls=el('div','','journey-buttons');
      const next=btn(index===shots.length-1?'Begin expedition':'Next scene',()=>{if(++index<shots.length)paint();else finish();});
      const skip=btn('Skip opening',finish);skip.dataset.skip='true';
      controls.append(next,skip);caption.append(controls);overlay.append(frame,caption);next.focus();
      if(!reduced()){
        const direction=index%2?1:-1;
        frame.animate([{opacity:0,transform:'scale(1.09)'},{opacity:1,offset:.14},{opacity:1,offset:.87},{opacity:0,transform:`translateX(${direction*3}%) scale(1.18)`}],{duration,fill:'both'});
        subtitle.animate([{opacity:0},{opacity:1,offset:.18},{opacity:1,offset:.87},{opacity:0}],{duration,fill:'both'});
        timer=setTimeout(()=>next.click(),duration);
      }
    }
    paint();
  }
  function recordProgress(){
    const run=getState();
    if(!run.runId||!['complete','defeat'].includes(run.phase))return null;
    if(Object.hasOwn(profile.progress.receipts,run.runId))return profile.progress.receipts[run.runId];
    const receipt=settleRun(profile.progress,run);
    if(receipt)writeProfile();
    return receipt;
  }
  function begin(tutorial,starter){
    newJourney(tutorial,{talisman:starter.id,xp:talismanStats(profile.progress,starter.id).xp,quickTutorial:tutorial});
    continueJourney();
  }
  function continueJourney(){
    close();
    resume();
  }
  function confirmNew(tutorial,starter){
    if(!hasSave()||['complete','defeat'].includes(getState().phase))return begin(tutorial,starter);
    show('Replace expedition?');mode='confirm';
    overlay.classList.add('journey-starter');
    const panel=el('div','','journey-menu starter-confirm');
    panel.append(el('h2','Begin a new journey?'),el('p','Your current expedition on this device will be replaced.'));
    panel.append(btn('Keep my expedition',continueJourney),btn('Begin new journey',()=>begin(tutorial,starter)));
    overlay.append(panel);panel.querySelector('button').focus();
  }
  function selectStarter(tutorial){
    show('Choose a Talisman');mode='starter';
    overlay.classList.add('journey-starter');
    overlay.style.backgroundImage='';
    let index=0;
    function paint(focusSelector='.starter-start',direction=0){
      const starter=talismans[index];
      const progress=profile.progress;
      const unlocked=talismanUnlocked(progress,starter.id);
      const stats=talismanStats(progress,starter.id);
      const panel=el('div','','journey-menu starter-menu');
      const outgoing=direction&&!reduced()?overlay.querySelector('.starter-emblem:not(.starter-emblem-outgoing)'):null;
      function choose(next,focus,direction=0){
        index=(next+talismans.length)%talismans.length;
        paint(focus,direction);
      }
      const chooser=el('div','','starter-chooser');
      const arrow=(name,direction,css)=>{
        const button=btn('',()=>choose(index+direction,'.'+css,direction));
        button.className='starter-arrow '+css;
        button.setAttribute('aria-label',name);button.title=name;
        const icon=el('img','','starter-arrow-icon');
        icon.src='combat-assets/talismans-v3/arrow-left-v1.png';
        icon.alt='';icon.width=24;icon.height=20;
        button.append(icon);
        return button;
      };
      if(!tutorial)chooser.append(arrow('Previous Talisman',-1,'starter-prev'));
      const emblem=el('span','','starter-emblem');
      const symbol=el('img','','starter-emblem-symbol');
      symbol.src='combat-assets/talismans-v3/'+starter.id+'.png';
      symbol.alt='';symbol.width=symbol.height=256;
      emblem.append(symbol);
      const emblemSlot=el('div','','starter-emblem-slot');
      emblemSlot.append(emblem);
      if(outgoing){
        const previous=outgoing.cloneNode(true);
        previous.classList.add('starter-emblem-outgoing');
        emblemSlot.prepend(previous);
        const motion={duration:260,easing:'ease-out'};
        const distance=direction*55;
        const currentStyle=getComputedStyle(outgoing);
        previous.animate([
          {transform:currentStyle.transform,opacity:currentStyle.opacity},
          {transform:'translateX('+distance+'%)',opacity:0},
        ],motion).onfinish=()=>previous.remove();
        emblem.animate([
          {transform:'translateX('+(-distance)+'%)',opacity:0},
          {transform:'translateX(0)',opacity:1},
        ],motion);
      }
      chooser.append(emblemSlot);
      if(!tutorial)chooser.append(arrow('Next Talisman',1,'starter-next'));
      panel.append(chooser,el('h2',starter.name),el('p',starter.line,'starter-description'));
      const squad=el('section','','starter-squad');
      squad.append(el('h3',starter.squad));
      const roster=el('div','','starter-roster');
      for(const [slot,id] of starter.order.entries()){
        const figure=el('figure','','starter-portrait');
        const reserve=slot===3;
        const portrait=el('span','','starter-avatar');
        const face=el('img');
        face.src='combat-assets/warden-avatars-v1/'+id+'.png';
        face.alt='';face.width=face.height=256;
        portrait.append(face);
        const caption=el('figcaption',heroes.find(hero=>hero.id===id).name);
        if(reserve){
          figure.classList.add('starter-reserve');
          caption.append(el('small','Reserve','starter-reserve-badge'));
        }
        figure.append(portrait,caption);
        roster.append(figure);
      }
      squad.append(roster);panel.append(squad);
      const next=xpRewards.find(reward=>reward.xp>stats.xp);
      const unlock=el('section','','starter-unlock');
      unlock.append(el('h3',next?'Next unlock':'All XP rewards unlocked'));
      if(next){
        const icon=el('span','','starter-reward-icon');
        paintDiceFace(icon,starter.order[0],next.token,'party');
        const bar=el('progress','','starter-xp');
        bar.max=next.xp;bar.value=stats.xp;bar.setAttribute('aria-label','Talisman XP');
        const track=el('div','','starter-xp-track');
        track.append(bar,el('span',stats.xp+' / '+next.xp,'starter-xp-value'));
        unlock.append(icon,track,el('small',next.label));
      }
      panel.append(unlock);
      if(!tutorial){
        const record=(next?'':stats.xp+' Talisman XP · ')+stats.wins+(stats.wins===1?' clear':' clears');
        panel.append(el('small',record,'starter-record'));
        const lockNote=unlocked?'':'Clear the expedition with the '+talismans[index-1].name+' to unlock.';
        panel.append(el('p',lockNote,'starter-lock-note'));
      }
      const start=btn('Start',()=>confirmNew(tutorial,starter));
      start.className='starter-start';start.disabled=!unlocked;
      const back=btn('Back',title);
      const actions=el('div','','starter-actions');
      actions.append(back,start);
      panel.append(actions);
      if(!tutorial){
        const pages=el('div','','starter-pages');pages.setAttribute('role','group');pages.setAttribute('aria-label','Talismans');
        for(const [page,talisman] of talismans.entries()){
          const dot=btn('●',()=>choose(page,'.starter-page-'+page));
          dot.className='starter-page-'+page;
          dot.setAttribute('aria-label',talisman.name);
          if(page===index)dot.setAttribute('aria-current','true');
          pages.append(dot);
        }
        panel.append(pages);
      }
      overlay.replaceChildren(panel);
      const focus=panel.querySelector(focusSelector);
      (focus&&!focus.disabled?focus:back).focus({preventScroll:true});
    }
    paint();
  }
  function compendium(){
    show('Compendium');mode='compendium';
    overlay.classList.add('journey-compendium');
    const panel=el('div','','journey-menu compendium-menu');panel.append(el('h2','Compendium'));
    panel.append(el('p','The Reedbound Marches · The Waymarks · Hollow Orchard'));
    panel.append(btn('Replay introduction',()=>opening(compendium)),btn('Learn to play',()=>selectStarter(true)),btn('Back',title));
    overlay.append(panel);panel.querySelector('button').focus();
  }
  function options(back=title){
    show('Options');mode='options';
    const panel=el('div','','journey-menu options-menu');panel.append(el('h2','OPTIONS'));
    const row=(name,input)=>{const label=el('label',name);label.append(input);panel.append(label);};
    const select=(key,values)=>{
      const input=el('select');for(const [value,label] of values)input.add(new Option(label,value));
      input.value=settings[key];input.onchange=()=>applySettings({[key]:Number(input.value)});return input;
    };
    row('Resolution',select('resolution',[[50,'50% render scale'],[75,'75% render scale'],[100,'100% render scale']]));
    const fullscreen=el('input');fullscreen.type='checkbox';fullscreen.checked=Boolean(document.fullscreenElement);fullscreen.disabled=!document.fullscreenEnabled;
    fullscreen.onchange=async()=>{try{if(fullscreen.checked)await document.documentElement.requestFullscreen();else if(document.fullscreenElement)await document.exitFullscreen();}catch{}fullscreen.checked=Boolean(document.fullscreenElement);};
    row('Fullscreen',fullscreen);
    const vsync=el('select');vsync.add(new Option('Managed by browser'));vsync.disabled=true;row('VSync',vsync);
    const language=el('select');language.add(new Option('English'));language.disabled=true;row('Language',language);
    for(const [key,name] of [['master','Master Volume'],['effects','Effects Volume'],['music','Music Volume']]){
      const slider=el('input');slider.type='range';slider.min=0;slider.max=100;slider.value=settings[key];
      slider.oninput=()=>applySettings({[key]:Number(slider.value)});slider.onchange=()=>cue('ui-tab');row(name,slider);
    }
    row('Combat Speed',select('speed',[[1,'×1'],[3,'×3']]));
    const motion=el('input');motion.type='checkbox';motion.checked=settings.motion;motion.onchange=()=>applySettings({motion:motion.checked});row('Reduce motion',motion);
    panel.append(btn('Controls',()=>{
      show('Controls');const list=el('div','','journey-menu options-menu');list.append(el('h2','Controls'),el('p','Select or use a die: click, tap, or focus it and press Enter.'),el('p','Cancel target selection or open the pause menu: Escape.'),btn('Back',()=>options(back)));overlay.append(list);list.querySelector('button').focus();
    }),btn('Restore Defaults',()=>{resetSettings();options(back);}),btn('Delete Save',()=>{
      show('Delete Save');const confirmation=el('div','','journey-menu options-menu');
      confirmation.append(el('h2','Delete Save?'),el('p','This removes your expedition, tutorial, Talisman XP and Trial progress on this device.'),btn('Cancel',()=>options(back)),btn('Delete Save',()=>{profile={version:1,openingSeen:false,tutorialDone:false,progress:freshProgress()};writeProfile();deleteSave();title();}));overlay.append(confirmation);confirmation.querySelector('button').focus();
    }),btn('Back',back));overlay.append(panel);panel.querySelector('select').focus();
  }
  function pause(){
    if(isBusy())return;
    show('Settings');mode='pause';
    overlay.classList.add('journey-pause');
    const panel=el('div','','journey-menu options-menu');
    panel.append(el('h2','Settings'),btn('Resume',close),btn('Options',()=>options(pause)),
      btn(leaveBattle?'Expedition Kit':'Main Menu',leaveBattle??title));
    overlay.append(panel);
    panel.querySelector('button').focus();
  }
  function leaveAccount(){
    title();
    overlay.querySelector('[data-account-menu]')?.focus({preventScroll:true});
  }
  async function account(){
    show('Account');mode='account';
    overlay.classList.add('journey-account');
    const panel=el('section','','journey-menu account-sheet');
    const heading=el('h1','Account');
    heading.tabIndex=-1;
    const avatar=el('span','','account-avatar');
    avatar.setAttribute('aria-hidden','true');
    const header=el('header','','account-heading');
    header.append(avatar,heading);
    const grid=el('div','','account-grid');
    function page(title, className){
      const section=el('section','',className);
      const list=el('dl');
      section.append(el('h2',title),list);
      grid.append(section);
      return list;
    }
    const row=(list,label,value)=>{
      const field=el('dd',value);
      const caption=el('dt',label);
      if(label.endsWith('Copper'))caption.className='account-copper';
      list.append(caption,field);
      return field;
    };
    const identity=page('Player Profile','account-identity');
    const player=row(identity,'Player ID','Checking…');
    const wallet=row(identity,'NEAR Testnet Wallet','Checking…');
    const social=row(identity,'Social Sign-in','Checking…');
    const profession=row(identity,'Profession','Checking…');
    const progress=page('Expedition Ledger','account-ledger');
    const starter=row(progress,'Starter Pack','Checking…');
    const relic=row(progress,'Starter Relic','—');
    const balance=row(progress,'Wallet Copper','Checking…');
    const available=row(progress,'Market Copper','—');
    const reserved=row(progress,'Reserved Copper','—');
    const run=getState();
    const squad=el('section','','account-squad');
    if(hasSave() && !['complete','defeat'].includes(run.phase) && run.heroes.length){
      squad.append(el('h2','Current Squad'));
      const roster=el('div','','account-roster');
      for(const hero of run.heroes){
        const figure=el('figure','','account-hero');
        const portrait=el('span','','account-hero-portrait');
        const image=el('img');
        image.src='combat-assets/warden-avatars-v1/'+hero.id+'.png';
        image.alt='';
        portrait.append(image);
        const caption=el('figcaption',hero.name);
        if(hero.bench)caption.append(el('small','Reserve','starter-reserve-badge'));
        figure.append(portrait,caption);
        roster.append(figure);
      }
      squad.append(roster);
    }
    const summary=el('div','','account-talismans');
    summary.append(el('h2','Talisman Progress'));
    for(const talisman of talismans){
      const stats=talismanStats(profile.progress,talisman.id);
      const tile=el('div','','account-talisman');
      const unlocked=talismanUnlocked(profile.progress,talisman.id);
      tile.append(el('strong',talisman.name),el('span',unlocked
        ? `${stats.wins} clears · Best Trial ${stats.bestTrial || '—'}` : 'Locked'));
      if(unlocked){
        const next=xpRewards.find(reward=>reward.xp>stats.xp);
        const bar=el('progress','','starter-xp');
        bar.max=next?.xp ?? xpRewards.at(-1).xp;
        bar.value=stats.xp;
        bar.setAttribute('aria-label',talisman.name+' XP');
        const track=el('div','','account-xp-track');
        track.append(bar,el('span',next ? `${stats.xp} / ${next.xp} XP` : `${stats.xp} XP`));
        tile.append(track);
        if(next){
          const reward=el('div','','account-xp-reward');
          const icon=el('span','','account-reward-icon');
          paintDiceFace(icon,talisman.order[0],next.token,'party');
          reward.append(icon,el('small',next.label));
          tile.append(reward);
        }else tile.append(el('small','All XP rewards unlocked'));
      }
      summary.append(tile);
    }
    const status=el('p','','account-status');
    status.setAttribute('role','status');
    panel.append(header,grid);
    if(squad.childElementCount)panel.append(squad);
    panel.append(summary,status,btn('Back',leaveAccount));
    overlay.append(panel);
    heading.focus({preventScroll:true});
    try{
      const session=await requestTitleAuth('session');
      if(!session)throw new Error('Session unavailable');
      player.textContent=session.playerId;
      wallet.textContent=session.accountId || 'Not linked';
      social.textContent=session.social ? 'Connected' : 'Not linked';
      const [pack,copper,career]=await Promise.allSettled([
        requestTitleAuth('starter'),
        session.accountId ? requestTitleAuth('economy/balances') : null,
        requestTitleAuth('professions'),
      ]);
      if(!panel.isConnected)return;
      if(career.status==='fulfilled'){
        const {active,quests}=career.value;
        profession.textContent=active
          ? quests?.find(quest=>quest.specialty===active)?.title || active : 'None selected';
      }else profession.textContent='Unavailable';
      if(pack.status==='fulfilled'){
        const data=pack.value;
        starter.textContent=({issued:'Ready',claimed:'Claimed',pending:'Pending'})[data.status] ?? 'Unavailable';
        relic.textContent=data.relicId || '—';
      }else starter.textContent='Unavailable';
      const formatCopper=value=>{
        if(!/^\d+$/.test(String(value)))return 'Unavailable';
        const units=BigInt(value);
        return `${units/100n}.${String(units%100n).padStart(2,'0')}`;
      };
      if(copper.status==='fulfilled'&&copper.value){
        balance.textContent=formatCopper(copper.value.wallet?.value);
        available.textContent=formatCopper(copper.value.allocation?.value?.available);
        reserved.textContent=formatCopper(copper.value.allocation?.value?.reserved);
      }else balance.textContent=session.accountId ? 'Unavailable' : 'Link a wallet';
    }catch{
      for(const field of [player,wallet,social,profession,starter,balance])field.textContent='Unavailable';
      status.textContent='Could not load your account. Return to the menu and open Account again.';
    }
  }
  const guestSessionKey='veilbound-title-guest';
  let signedIn=false;
  function title(boot=false){
    if(!signedIn)return titleLogin(boot);
    return titleMenu(boot);
  }
  function titleLogin(boot){
    const view=titleMenu(true);
    if(!view)return;
    mode='title-login';
    const {panel}=view;
    const status=el('p','','title-login-status');status.setAttribute('role','status');
    const enter=async method=>{
      const buttons=[...panel.querySelectorAll('button')];
      buttons.forEach(button=>{button.disabled=true;});
      status.textContent='Finish signing in in the popup.';
      const controller=new AbortController();
      const cancel=btn('Cancel sign-in',()=>controller.abort());
      panel.append(cancel);
      try{
        await openTitleLogin(method,controller.signal);
        signedIn=true;
        titleMenu();
      }catch(error){
        status.textContent=error.message;
        buttons.forEach(button=>{button.disabled=false;});
        buttons[method==='wallet'?0:1]?.focus({preventScroll:true});
      }finally{
        cancel.remove();
      }
    };
    const playGuest=btn('Play as Guest', async ()=>{
      const buttons=[...panel.querySelectorAll('button')];
      buttons.forEach(button=>{button.disabled=true;});
      status.textContent='Preparing your expedition…';
      try{
        const guest=await requestTitleAuth('guest',{});
        if(!guest?.playerId)throw new Error('Guest session unavailable.');
        localStorage.setItem(guestSessionKey,guest.playerId);
        signedIn=true;
        if(hasSave())titleMenu();
        else selectStarter(true);
      }catch{
        status.textContent='Could not open a guest expedition. Try again.';
        buttons.forEach(button=>{button.disabled=false;});
      }
    });
    panel.classList.add('title-login');
    panel.setAttribute('aria-label','Sign in');
    overlay.setAttribute('aria-label','Sign in to VEILBOUND');
    panel.replaceChildren(btn('Login with Wallet',()=>enter('wallet')),btn('Login with Social',()=>enter('social')),playGuest,status);
    if(boot)return view;
    view.heading.append(titleLogo);
    panel.inert=false;
  }
  function titleMenu(boot=false){
    if(isBusy())return;
    setMusicScene('menu');
    setMusicEnabled(true);
    show('VEILBOUND main menu');mode='title';
    overlay.style.backgroundImage='radial-gradient(ellipse at 50% 30%,#17100ecf,#090706fa 75%),url("combat-assets/orchard-expedition-panorama-v2.png")';
    overlay.classList.add('journey-title');
    const panel=el('nav','','journey-menu title-menu');
    panel.setAttribute('aria-label','Main menu');
    const continueButton=btn('Continue',continueJourney);continueButton.disabled=!hasSave();
    const accountButton=btn('Account',account);accountButton.dataset.accountMenu='';
    panel.append(btn('New Game',()=>selectStarter(!profile.tutorialDone)),continueButton,btn('Compendium',compendium),btn('Options',()=>options()),accountButton,btn('Quit',()=>{
      show('Quit');overlay.style.backgroundImage='none';
      setMusicEnabled(false);
      const screen=el('div','','journey-menu');screen.append(el('p','You can close this tab.'),btn('Return to Main Menu',title));overlay.append(screen);screen.querySelector('button').focus();
    }));
    for(const [label,path] of [['Expedition','/online-expedition.html'],['Marketplace','/economy.html'],['Game Modes','/modes.html']]){
      panel.append(btn(label,()=>location.assign(path)));
    }
    const stage=el('div','','title-stage');
    stage.setAttribute('aria-hidden','true');
    stage.append(titleArt);
    for(const name of ['title-halo','title-gate-light','title-vignette','title-water-light'])
      stage.append(el('div','',name));
    const heading=el('h1','','title-heading');
    if(!boot)heading.append(titleLogo);
    overlay.append(stage,heading,panel);
    const focus=()=>{if(mode==='title')(hasSave()?continueButton:panel.querySelector('button')).focus({preventScroll:true});};
    if(!boot){focus();return;}
    panel.inert=true;
    return {heading,panel,focus};
  }
  function complete(id){
    const t=getState().tutorial;
    if(t?.enabled&&!t.completed.includes(id)){t.completed.push(id);saveRun();}
  }
  function notify(type,result){
    if(type==='action'){
      if(result.actor==='rook'&&result.key==='guard')complete('guard');
      if(result.side==='foe')complete('enemy');
      if(result.side==='party'&&result.type==='rotate')complete('rotate');
      if(result.side==='foe'&&result.type==='rotate')complete('enemy-rotate');
      if(result.actor==='mara'&&result.targets.some(key=>key.startsWith('e')))complete('target');
    }
    if(type==='round')complete('round');
    refresh();
  }
  function refresh(){
    const s=getState(),t=s.tutorial;
    if(!coach.hidden&&coach.dataset.page==='versus'&&lessonPage(s)?.[0]==='versus'&&overlay.hidden&&!isBusy())return;
    document.querySelectorAll('.tutorial-focus').forEach(e=>e.classList.remove('tutorial-focus'));
    coach.hidden=true;spotlight.hidden=true;focusTarget=null;allowedSelector=null;
    if(!overlay.hidden||isBusy())return;
    const page=lessonPage(s);
    if(page){
      const advance=()=>{clearTimeout(versusTimer);t.introPage++;resume();};
      if(page[0]==='versus'){
        const canvas=document.querySelector('#battlefield');
        if(!canvas?.dataset.arena&&!canvas?.dataset.assetError)return;
        const duration=reduced()?250:600/settings.speed;
        coach.replaceChildren(el('p',page[1],'intro-title'));
        allowedSelector='';
        clearTimeout(versusTimer);versusTimer=setTimeout(()=>{if(overlay.hidden&&lessonPage(getState())?.[0]==='versus')advance();},duration);
      }else{
        const bubble=speech(page[1],advance);
        coach.replaceChildren(bubble);
        const frames={enemies:[.53,-.08,.52,1.16],allies:[-.05,-.08,.56,1.16],traits:[-.05,-.08,.56,1.16],
          leads:[.32,.44,.36,.32],ready:[.32,.44,.36,.32],light:[-.06,.82,1.12,.26],dark:[-.06,.82,1.12,.26],controls:[-.06,.82,1.12,.26]};
        illuminate(frames[page[0]]);
        if(!reduced()){
          coach.animate([{opacity:0},{opacity:1}],{duration:cinematic.tutorialIn});
          spotlight.animate([{opacity:0},{opacity:1}],{duration:cinematic.tutorialIn});
        }
        if(page[0]==='traits'){
          const card=el('div','','lesson-trait');
          card.append(el('strong','Rook Calder'),el('p','Guard → blocks the next direct attack.'));
          coach.append(card);
        }
      }
      coach.dataset.page=page[0];coach.hidden=false;
      coach.querySelector('button')?.focus({preventScroll:true});
      return;
    }
    delete coach.dataset.page;
    if(!t?.enabled)return;
    if(t.quick&&s.phase==='defeat'){
      coach.replaceChildren(btn('Retry lesson',()=>begin(true,talismans.find(item=>item.id===s.talisman)??talismans[0])),
        btn('End lesson',finishTutorial));
      coach.hidden=false;
      return;
    }
    if(t.quick&&s.phase==='map'&&s.node==='road'){
      finishTutorial();
      return;
    }
    if(t.quick&&s.phase==='reward')return;
    const explain=(id,text,target)=>{
      coach.dataset.page=id;
      const bubble=speech(text,()=>{complete(id);refresh();});
      coach.replaceChildren(bubble);coach.hidden=false;illuminate(target);bubble.focus({preventScroll:true});
      if(!reduced()){
        coach.animate([{opacity:0},{opacity:1}],{duration:cinematic.tutorialIn});
        spotlight.animate([{opacity:0},{opacity:1}],{duration:cinematic.tutorialIn});
      }
    };
    let text,selector;
    const done=id=>t.completed.includes(id);
    if(s.phase==='event'&&s.node==='threshold'){
      text='Choose a traveling reserve and prepare two techniques for each warden.';selector='.loadout';
    }else if(s.phase==='map'&&s.node==='threshold'){
      text='Choose the lit path to The Listening Road.';selector='#nodes .reachable';
    }else if(s.phase==='battle'&&s.node==='road'){
      const usable=id=>s.battle.dice.some(d=>d.id===id&&!d.spent);
      if(s.battle.lead){
        const end=document.querySelector('#end-round');
        if(done('round')||done('turn-explained')||end.disabled)return;
        explain('turn-explained','The enemy dice are used. End Turn rolls both sides again. You may still use your remaining dice.','#end-round');
        return;
      }else if(!done('guard')&&usable('rook')&&s.battle.dice.find(d=>d.id==='rook').face==='guard'){
        text="Use Rook's Guard before the roots strike. Each die belongs to its warden.";selector='#die-rook';
      }else if(!done('enemy')&&s.battle.dice.some(d=>d.side==='foe'&&!d.spent)){
        text='You control both sides. Choose a dark die to let an enemy intent unfold.';selector='#enemy-dice';
      }else if(!done('target')&&usable('mara')){
        const targeting=document.querySelector('#target-layer button');
        text=targeting?'Choose one of the marked enemies.':"Choose Mara's die, then a marked target within reach.";
        selector=targeting?'#target-layer button':'#die-mara';
      }else if(!done('round')){
        text='Resolve the remaining enemy dice, then End Turn. Unused warden dice may be left behind.';selector='#end-round';
      }else{
        text='Choose the order freely. Reroll is an expedition perk: once per turn, for unused dice of both sides.';selector='#reroll';
      }
    }else if(s.phase==='reward'){
      if(s.node!=='road'||!s.battle||document.querySelector('#loot-diary').hidden)return;
      const loot=s.battle.tutorialLoot??{};
      if(loot.shield&&!done('gear-explained')){
        explain('gear-explained','Bark Shield went into your Travel Diary. You can equip it on a warden.','#loot-gear-slot');
      }else if(s.pack.equipment.includes('bark-shield')&&s.heroes.some(hero=>hero.hp&&!hero.bench&&hero.equipment.includes(null)&&!hero.equipment.includes('bark-shield'))&&!done('equip-skipped')){
        coach.dataset.page='gear-equip';
        const skip=btn('Equip later',()=>{complete('equip-skipped');refresh();});
        coach.replaceChildren(el('p','Choose a warden to equip Bark Shield.'),skip);
        coach.hidden=false;illuminate('#loot-roster','#loot-roster button');
        document.querySelector('#loot-roster button')?.focus({preventScroll:true});
      }else if(loot.salve&&!done('token-explained')){
        explain('token-explained','Reed Salve is a combat token. Use it to heal a warden.','#loot-token-slot');
      }
      return;
    }else if(s.phase==='map'&&s.node!=='threshold'){
      if(!done('diary-explained'))explain('diary-explained','Open the Travel Diary while traveling to check your wardens and equipment.','#satchel-menu summary');
      else if(!done('route-explained'))explain('route-explained','The jade trails lead to your next stops. Choose one to travel.','#route-scroll');
      else {
        coach.dataset.page='route-click';
        const choice=document.querySelector('#nodes .reachable');
        if(!choice){finishTutorial();return;}
        illuminate('#route-scroll','#nodes .reachable');
        choice.focus({preventScroll:true});
      }
      return;
    }else if(['complete','defeat'].includes(s.phase)){
      finishTutorial();return;
    }else return;
    coach.replaceChildren();
    const copy=el('p',text);copy.setAttribute('role','status');coach.append(copy);
    coach.append(btn('Dismiss guidance',finishTutorial));
    coach.hidden=false;
    const focus=document.querySelector(selector);focus?.classList.add('tutorial-focus');
  }
  function finishTutorial(){
    const t=getState().tutorial;if(t)t.enabled=false;
    profile.combatLesson='video';profile.tutorialDone=true;writeProfile();saveRun();refresh();
  }
  async function launch(){
    main.inert=true;
    const session=requestTitleAuth('session').catch(()=>null);
    await Promise.allSettled([titleArt.decode(),titleLogo.decode(),document.fonts.ready,session]);
    const account=await session;
    signedIn=titleAuthenticated(account)||Boolean(account?.playerId&&
      localStorage.getItem(guestSessionKey)===account.playerId);
    const {heading,panel}=title(true);
    const start=titleLogo.getBoundingClientRect();
    heading.append(titleLogo);
    const end=titleLogo.getBoundingClientRect();
    if(!reduced()&&start.width&&end.width){
      loading.classList.add('title-cover');
      overlay.append(loading);
      const scale=start.width/end.width;
      const x=start.left+start.width/2-end.left-end.width/2;
      const y=start.top+start.height/2-end.top-end.height/2;
      const flight=titleLogo.animate([
        {transform:`translate(${x}px,${y}px) scale(${scale})`},
        {transform:'translateY(-5.5svh) scale(.91)',offset:.69},
        {transform:'none'},
      ],{duration:950,easing:'cubic-bezier(.22,.68,.23,1)'});
      const reveal=loading.animate([{opacity:1},{opacity:0}],{duration:690,fill:'forwards',easing:'ease-out'});
      panel.animate([{opacity:0,transform:'translateY(7px)'},{opacity:1,transform:'none'}],
        {delay:650,duration:300,fill:'both',easing:'ease-out'});
      await Promise.allSettled([flight.finished,reveal.finished]);
    }
    loading.remove();
    panel.inert=false;
    if(!reduced())heading.append(el('span','','title-glint'));
  }
  return {title,pause,launch,notify,refresh,recordProgress,selectStarter};
}
