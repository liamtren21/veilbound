import { storyChoices, storyOffer, storyPresentation, STORY_VERSION } from '../../../expedition-data.mjs';
import { CURSE_DEFINITIONS } from '../../../expedition-curses.mjs';

export function recordStoryMemory(account, run, choice) {
  const { node, storyVersion } = run.state;
  const speaker = storyPresentation[node]?.speaker;
  if (storyVersion !== STORY_VERSION || !speaker) return;
  const memory = account.storyMemory ??= {};
  const events = memory[speaker] ??= [];
  events.push({ eventId: run.runId + ':' + run.version, node, choice,
    runId: run.runId, storyVersion });
  if (events.length > 24) events.shift();
}

export function dialogueContext(run, memory) {
  const { state } = run;
  if (state.phase !== 'event') return { node: null };
  const speaker = storyPresentation[state.node]?.speaker;
  return {
    node: state.node,
    storyVersion: state.storyVersion,
    supply: { copper: state.copper, salve: state.pack.salve, heartwood: state.pack.heartwood },
    heroes: state.heroes.map(hero => ({
      name: hero.name,
      hp: hero.hp,
      maxHp: hero.maxHp,
      curses: Object.keys(CURSE_DEFINITIONS).filter(id =>
        Object.values(hero.curses?.[id]?.sources ?? {}).length > 0),
    })),
    choices: storyChoices(state),
    offer: storyOffer(state),
    history: (memory?.[speaker] ?? []).slice(-5).map(({node,choice}) => ({node,choice})),
  };
}
