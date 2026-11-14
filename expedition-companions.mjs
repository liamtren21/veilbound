export const SUMMON_FACE='summon';
export const SUMMON_LIMIT=3;
export const SUMMON_ROUNDS=2;

export const companions=Object.freeze({
  brinewisp:{name:'Brinewisp',bond:'Mara Venn',element:'Water',hp:6,str:9,int:0,def:1,
    skill:'Undercurrent',effect:'strike',text:'Attacks the enemy lead for 9 damage before defenses.'},
  flintback:{name:'Flintback',bond:'Rook Calder',element:'Earth',hp:8,str:0,int:0,def:4,
    skill:'Stone Shelter',effect:'ward',text:'Gives its summoner 8 personal Defense.'},
  chimewing:{name:'Chimewing',bond:'Elian Reed',element:'Spirit',hp:5,str:0,int:10,def:1,
    skill:'Mending Chime',effect:'heal',text:'Restores 10 HP to the most injured living warden.'},
  waxwing:{name:'Waxwing',bond:'Tess Ashdown',element:'Wood',hp:5,str:5,int:0,def:1,
    skill:'Trail Mark',effect:'mark',text:'Attacks the enemy lead for 5 damage and Marks it if the attack connects.'},
  cindermoth:{name:'Cindermoth',bond:'Nera Voss',element:'Fire',hp:4,str:0,int:8,def:0,
    skill:'Cinder Dust',effect:'scorch',text:'Attacks the enemy lead for 8 damage and adds 3 Bleed if the attack connects.'},
  scriptfin:{name:'Scriptfin',bond:'Gideon Rusk',element:'Spirit',hp:5,str:0,int:6,def:2,
    skill:'Clearwater Script',effect:'cleanse',text:'Clears Bleed and Rooted from its summoner and restores 6 HP.'},
});

const heroCompanions=Object.freeze({
  mara:'brinewisp', rook:'flintback', elian:'chimewing',
  tess:'waxwing', nera:'cindermoth', gideon:'scriptfin',
});

export const companionForHero=hero=>heroCompanions[hero?.id];

export function restoreCompanionBond(state){
  delete state.companionId;
  const pet=state.battle?.companion;
  if(!pet)return;
  const id=companionForHero(state.heroes.find(hero=>hero.key===pet.owner));
  if(!id){state.battle.companion=null;return;}
  if(pet.id===id)return;
  pet.id=id;
  pet.hp=Math.min(pet.hp,companions[id].hp);
  pet.defense=Math.min(pet.defense,companions[id].def);
}

export function canOfferSummon(state){
  return state.phase==='battle'&&!state.battle.companion&&(state.battle.summonCount??0)<SUMMON_LIMIT&&
    !(state.node==='road'&&(state.tutorial?.enabled||state.tutorial?.videoVersion===1));
}
