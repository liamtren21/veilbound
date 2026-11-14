const shapes = {
  sword: 'M25 4 28 7 17 19 13 15Z M10 13 19 22 M14 19 7 26 M4 24 8 28',
  hammer: 'M7 7 17 3 23 9 13 15Z M12 13 18 19 10 27 6 23 14 15 M24 19 28 18 M23 23 27 26',
  stone: 'M3 24 7 16 13 15 18 23 14 27H5Z M16 22 21 12 27 14 30 22 25 27H20Z M8 11 12 5 18 4 22 9 18 13H12Z',
  hook: 'M8 27 23 9 Q27 3 21 4 Q17 4 17 8 M6 24 10 28',
  fork: 'M16 13V28 M9 4V10Q9 15 16 15Q23 15 23 10V4 M16 4V10',
  arrow: 'M5 27 26 6 M17 6H26V15 M6 20V26H12 M7 15 16 24',
  shield: 'M16 4Q22 8 27 8V16Q27 23 16 29Q5 23 5 16V8Q10 8 16 4Z M16 5V26',
  shift: 'M7 12A10 10 0 0 1 25 10 M25 5V12H18 M25 20A10 10 0 0 1 7 22 M7 27V20H14',
  turn: 'M10 25A10 10 0 1 1 26 14 M26 6V15H17',
  randomTurn: 'M5 8Q12 8 16 16T27 24 M22 19 27 24 22 29 M5 24Q10 24 13 19 M19 13Q22 8 27 8 M22 3 27 8 22 13',
  bow: 'M6 5Q21 5 26 25L6 5Z M10 24 25 9 M19 9H25V15',
  ward: 'M16 3 28 16 16 29 4 16Z M16 11V21 M11 16H21',
  band: 'M6 7 27 12 24 19 4 14Z M5 16 25 22 22 28 3 22Z M12 9 10 15 M21 11 19 17',
  cover: 'M6 10 15 6 24 10V17Q24 23 15 28Q6 23 6 17Z M20 5 27 8V18 M11 17 14 20 20 13',
  wave: 'M3 24Q9 26 13 14Q17 4 25 8Q29 10 27 15Q24 10 21 14Q18 18 22 22Q25 25 29 22 M4 27H28',
  cut: 'M7 23 23 6 M12 26 28 10 M6 14Q1 20 6 20Q10 20 6 14Z',
  ferry: 'M4 19H28L23 25H9Z M16 6V19 M16 6 23 15H16 M5 28H27',
  heal: 'M13 5H19V12H26V18H19V25H13V18H6V12H13Z M24 4V8 M22 6H26',
  chime: 'M5 22H27L24 18V12Q24 6 16 6Q8 6 8 12V18Z M17 8 14 13 18 15 14 20 M13 26Q16 29 19 26',
  spark: 'M16 4 19 12 28 16 19 20 16 28 12 20 4 16 12 12Z M25 4V10 M22 7H28',
  mark: 'M16 6A10 10 0 1 1 16 26A10 10 0 0 1 16 6Z M16 12A4 4 0 1 1 16 20A4 4 0 0 1 16 12Z M16 3V8 M16 24V29',
  pin: 'M7 26 24 6 27 9 11 28Z M20 5 28 12 M5 18 10 18 M14 26V30',
  volley: 'M7 27 25 9 M17 9H25V17 M4 17 15 6 M9 6H15V12 M17 28 28 17',
  seal: 'M5 10H27V25H5Z M10 10V6H22V10 M11 17H21 M16 13V22',
  knot: 'M16 10Q8 3 5 10Q2 17 10 20Q16 23 22 20Q30 17 27 10Q24 3 16 10L9 26 M16 10 23 26',
  lamp: 'M11 8Q11 3 16 3Q21 3 21 8 M9 9H23L26 24H6Z M8 28H24 M16 12Q10 20 16 21Q22 20 16 12Z',
  scythe: 'M6 27 21 8 M7 7Q17 2 27 9Q25 13 20 14 M4 25 8 29',
  fang: 'M5 7Q18 3 27 10Q25 23 12 28Q17 19 14 14Q11 10 5 7Z M20 6 25 3',
  thorn: 'M5 27 24 7 M11 21 7 14 16 16 M18 14 17 6 24 7 28 4 M14 24 23 23 20 17',
  pull: 'M27 7Q25 24 14 24Q7 24 6 17 M3 21 6 16 11 20 M14 10 24 10 27 7 23 4',
  root: 'M16 4V18 M16 10 8 6 M16 13 24 8 M16 18 5 26 M16 18 12 28 M16 18 22 28 M16 18 27 23',
  bark: 'M8 5H24L27 16 24 26H8L5 16Z M12 8 10 14 13 18 11 24 M20 8 22 13 19 18 21 24',
  graft: 'M16 27V16 M16 20Q5 18 5 8Q15 7 16 20Z M16 17Q17 7 27 5Q28 15 16 17Z',
  gate: 'M6 26V12L16 4 26 12V26Z M12 25V13H20V25 M16 13V25',
  eye: 'M3 16Q9 8 16 8Q23 8 29 16Q23 24 16 24Q9 24 3 16Z M16 12A4 4 0 1 1 16 20A4 4 0 0 1 16 12Z',
  sweep: 'M5 24V14 M5 14 2 18 M5 14 8 18 M16 24V6 M16 6 12 11 M16 6 20 11 M27 24V14 M27 14 24 18 M27 14 30 18',
  siege: 'M5 5 11 11 M27 5 21 11 M5 27 11 21 M27 27 21 21 M16 8 24 16 16 24 8 16Z',
};

const party = {
  guard:'shield', shift:'shift', brace:'ward', salve:'heal',
  'brace-line':'band', 'stone-answer':'stone', 'take-weight':'cover',
  undertow:'wave', 'open-seam':'cut', 'ferry-line':'ferry',
  'mending-note':'heal', 'fracture-chime':'chime', 'clear-tone':'spark',
  'red-thread':'mark', 'pin-hem':'pin', 'final-delivery':'volley',
  'witness-seal':'seal', 'ferrymans-knot':'knot', 'wayfarers-lamp':'lamp', 'iron-needle':'sword',
};
const foe = {
  rake:'scythe', lunge:'fang', thorn:'thorn', pierce:'arrow', pull:'pull',
  root:'root', bark:'bark', graft:'graft', guard:'gate', idle:'eye', sweep:'sweep', siege:'siege',
  'foe-ranged':'arrow','foe-boost':'ward','foe-purify':'heal','foe-target':'mark',
};
const strike = {rook:'hammer', mara:'hook', elian:'fork', tess:'bow'};
const svgNS = 'http://www.w3.org/2000/svg';
const paintedStrike={rook:0,mara:1,elian:2,tess:3};
const paintedParty={guard:4,'rotate-left':5,'rotate-right':5,idle:6,undertow:7};
const paintedFoe={rake:0,lunge:1,pull:2,'rotate-left':3,'rotate-right':3,guard:4,idle:5,clash:6,pierce:7,'foe-ranged':7};
export function paintDie(element,actor,action,side){
  const index=side==='foe'?paintedFoe[action]:action==='strike'?paintedStrike[actor]:paintedParty[action];
  if(index===undefined)return;
  element.classList.add('painted-die-face');
  element.style.setProperty('--painted-die-position',index%3*50+'% '+Math.floor(index/3)*50+'%');
  if(action==='rotate-right')element.classList.add('mirrored-die-face');
}

export function dieGlyph(actor, action, side) {
  const rotations={rotate:'shift','rotate-left':'turn','rotate-right':'turn','rotate-random':'randomTurn'};
  const icon = action==='bulk-up'?'ward':action==='clash'?'cut':rotations[action]??(side === 'foe' ? foe[action] :
    action==='ranged'?'arrow':action==='idle'?'eye':action==='strike'?strike[actor]:party[action]);
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svgNS, 'path');
  if(action==='rotate-left')path.setAttribute('transform','translate(32 0) scale(-1 1)');
  path.setAttribute('d', shapes[icon] ?? shapes.spark);
  svg.append(path);
  return svg;
}
