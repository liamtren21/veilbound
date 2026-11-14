// Dicefolk IL2CPP: CombatIntroView.MainCoroutine 0x17c36d0,
// CombatOutroView.MainCoroutine 0x17c22d0, TutorialPageView and Spawn prefab.
export const cinematic = Object.freeze({
  introEnter: 500,
  introHold: 1500,
  introExit: 500,
  titleExit: 250,
  tutorialIn: 500,
  tutorialOut: 250,
  spawn: 1500,
  outroEnter: 500,
  outroHold: 2000,
  outroFinalHold: 5000,
  sceneIn: 500,
  sceneOut: 750,
});

export function motionWindow(node, start, center, end, {enter, exit, duration}){
  if(!node)return;
  return node.animate([
    {...start,offset:0,easing:'ease-out'},
    {...center,offset:enter/duration},
    {...center,offset:1-exit/duration,easing:'ease-in'},
    {...end,offset:1},
  ],{duration,fill:'both'});
}
