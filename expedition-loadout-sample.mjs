import {active, chooseEvent, dieFaces, enter, newRun, resolve} from './expedition-rules.mjs';
import {companionForHero, companions, SUMMON_FACE} from './expedition-companions.mjs';

function sampleBattle(talisman, setup) {
  const state = newRun(42, {talisman, runId:'loadout-sample'});
  setup(state);
  chooseEvent(state, 'enter');
  enter(state, 'road');
  return state;
}

export function previewLoadout(talisman, {companionId, relicStage} = {}) {
  const relic = Number.isInteger(relicStage) && relicStage >= 0 && relicStage <= 2;
  if (!relic && !Object.hasOwn(companions, companionId)) return null;
  const bond = !relic;
  const setup = (state, equipped) => {
    if (bond) {
      const hero = active(state.heroes).find(unit => companionForHero(unit) === companionId);
      if (!hero) return;
      state.heroes = [hero, ...state.heroes.filter(unit => unit !== hero)];
      if (companions[companionId].effect === 'heal') hero.hp -= 14;
      if (equipped) state.nftLoadout = {companionId, companionRules:1};
    } else {
      const hero = active(state.heroes).find(unit => unit.id !== 'mara');
      if (!hero) return;
      state.heroes = [hero, ...state.heroes.filter(unit => unit !== hero)];
      if (equipped) {
        state.heroes.find(unit => unit.id === 'mara').equipment[0] = 'ferryman-cord';
        state.nftLoadout = {relicStage};
      }
    }
  };

  const before = sampleBattle(talisman, state => setup(state, false));
  const after = sampleBattle(talisman, state => setup(state, true));
  const hero = active(after.heroes).find(unit => bond ? companionForHero(unit) === companionId : unit.id === 'mara');
  if (!hero) return null;

  if (bond) {
    const beforeDice = before.battle.dice.filter(die => die.side === 'party');
    const afterDice = after.battle.dice.filter(die => die.side === 'party');
    const resultDie = afterDice.find(die => dieFaces(after, die).includes(SUMMON_FACE));
    if (!resultDie) return null;
    const changes = afterDice.flatMap((die, index) => dieFaces(after, die).flatMap((face, faceIndex) => {
      const previous = dieFaces(before, beforeDice[index])[faceIndex];
      return previous === face ? [] : [{die: index + 1, before: previous, after: face}];
    }));
    resultDie.face = SUMMON_FACE;
    const result = resolve(after, resultDie.id);
    return {hero, changes, result: result?.changes.map(change => change.text) ?? []};
  }

  const outcome = state => {
    const rotation = state.battle.dice.find(die => die.side === 'party' && dieFaces(state, die).includes('rotate'));
    if (!rotation) return {defense:0, result:[]};
    rotation.face = 'rotate';
    const target = state.heroes.find(unit => unit.id === 'mara');
    const initial = target.ward;
    const result = resolve(state, rotation.id, target.key);
    return {defense:target.ward - initial, result:result?.changes.map(change => change.text) ?? []};
  };
  return {hero, changes:[{before:'rotate',after:'rotate'}], before:outcome(before), after:outcome(after)};
}
