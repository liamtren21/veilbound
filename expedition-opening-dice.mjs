const duration = 1460;
const stagger = 42;

function flightFrames(from, to, floor, size) {
  const transform = (x, y, scale) =>
    `translate3d(${x - size / 2}px,${y - size / 2}px,0) scale(${scale})`;
  return Array.from({length: 101}, (_, frame) => {
    const t = frame / 100;
    if (t <= .72) {
      const roll = t / .72;
      const fall = Math.min(1, roll / .49);
      const bounce = (start, end, height) => {
        const progress = Math.max(0, Math.min(1, (roll - start) / (end - start)));
        return 4 * height * progress * (1 - progress);
      };
      const height = bounce(.49, .77, size * .52) + bounce(.77, 1, size * .15);
      const x = from + (to.rollX - from) * roll;
      const y = -size + (floor + size) * fall * fall - height;
      return {transform: transform(x, y, 1)};
    }
    const approach = (t - .72) / .28;
    const eased = approach * approach * (3 - 2 * approach);
    return {transform: transform(
      to.rollX + (to.x - to.rollX) * eased,
      floor + (to.y - floor) * eased - size * .25 * Math.sin(Math.PI * approach),
      1 + (to.scale - 1) * eased
    )};
  });
}

export async function tumbleIntoHud(slots, {speed = 1, onContact, onDock} = {}) {
  if (slots.length !== 3) return false;
  const faces = slots.map(slot => slot.querySelector('.cube'));
  const bounds = slots.map(slot => slot.querySelector('.cube-space')?.getBoundingClientRect());
  if (slots.some((slot, i) => !slot.isConnected || !faces[i] || !bounds[i]?.width)) return false;

  const {clientWidth: width, clientHeight: height} = document.documentElement;
  const size = Math.min(92, Math.max(47, width * .10), height * .16);
  const wrapper = document.createElement('div');
  wrapper.className = 'opening-dice';
  wrapper.setAttribute('aria-hidden', 'true');
  document.body.append(wrapper);

  const tracks = [];
  let contact;
  try {
    const shade = document.createElement('span');
    shade.className = 'opening-dice-shade';
    wrapper.append(shade);
    shade.animate([
      {opacity: 0, offset: 0, easing: 'ease-out'},
      {opacity: 1, offset: .25},
      {opacity: 1, offset: .78, easing: 'ease-in-out'},
      {opacity: 0, offset: 1},
    ], {duration: (duration + stagger * (slots.length - 1)) / speed, fill: 'both'});

    for (const [i, slot] of slots.entries()) {
      const box = bounds[i];
      const die = document.createElement('span');
      die.className = 'die party opening-die';
      die.style.setProperty('--die-size', size + 'px');
      const space = document.createElement('span');
      space.className = 'cube-space opening-space';
      const cube = faces[i].cloneNode(true);
      space.append(cube);
      const glow = document.createElement('span');
      glow.className = 'opening-die-glow';
      die.append(glow, space);
      wrapper.append(die);

      const lane = (i - 1) * size * 1.85;
      const to = {x: box.left + box.width / 2, y: box.top + box.height / 2,
        scale: box.width / size, rollX: width * .5 + lane};
      const floor = Math.min(height * (.65 + i * .024), to.y - size * .68);
      const timing = {duration: duration / speed, delay: i * stagger / speed, fill: 'both'};
      const spin = i === 1 ? -1 : 1;
      const pose = (x, y, z) => `rotateX(${x}deg) rotateY(${y}deg) rotateZ(${z}deg)`;
      const motion = die.animate(flightFrames(to.rollX - size * (.28 + .12 * i), to, floor, size), timing);
      tracks.push({slot, die, motion});
      glow.animate([
        {opacity: .35, offset: 0},
        {opacity: .72, offset: .32},
        {opacity: 1, offset: .355, easing: 'ease-out'},
        {opacity: .62, offset: .49},
        {opacity: .56, offset: .74, easing: 'ease-in-out'},
        {opacity: 0, offset: 1},
      ], timing);
      cube.animate([
        {transform: pose(-620 + 36 * i, spin * -365, -74 + 25 * i), offset: 0},
        {transform: pose(-344, spin * -197, -37), offset: .34, easing: 'cubic-bezier(.14,.36,.66,.8)'},
        {transform: pose(-155, spin * -76, 14), offset: .56, easing: 'ease-out'},
        {transform: pose(-53, spin * -28, 9), offset: .72, easing: 'ease-out'},
        {transform: pose(0, 0, 0), offset: 1},
      ], timing);
      slot.classList.add('awaiting-opening-die');
    }

    if(onContact)contact=setTimeout(onContact,duration*.72*.49/speed);
    await Promise.allSettled(tracks.map(async ({slot, die, motion}, index) => {
      await motion.finished;
      die.remove();
      slot.classList.remove('awaiting-opening-die');
      if(index===tracks.length-1)onDock?.();
    }));
    return true;
  } finally {
    clearTimeout(contact);
    wrapper.remove();
    for (const {slot} of tracks) slot.classList.remove('awaiting-opening-die');
  }
}
