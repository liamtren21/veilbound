const status = document.querySelector('#status');
const id = new URLSearchParams(location.search).get('id');
const path = '/api/journeys/' + encodeURIComponent(id ?? '');
const control = document.querySelector('#challenge');

function renderReplay(frames) {
  if (!frames?.length) return;
  document.querySelector('#replay').hidden = false;
  const slider = document.querySelector('#position');
  const play = document.querySelector('#play');
  slider.max = frames.length - 1;
  let timer;
  function stop() {
    clearInterval(timer);
    timer = undefined;
    play.textContent = 'Play';
  }
  function draw() {
    const index = Number(slider.value);
    const frame = frames[index];
    document.querySelector('#location').textContent = frame.location;
    document.querySelector('#frame').textContent = (index + 1) + '/' + frames.length + ' · ' + frame.report;
    for (const side of ['party', 'enemies']) {
      document.querySelector('#' + side).replaceChildren(...frame[side].map(unit => {
        const row = document.createElement('li');
        row.textContent = unit.name + ' · ' + unit.hp + '/' + unit.maxHp + ' HP' +
          (unit.defense ? ' · ' + unit.defense + ' Defense' : '');
        return row;
      }));
    }
  }
  slider.addEventListener('input', () => { stop(); draw(); });
  play.addEventListener('click', () => {
    if (timer) return stop();
    if (slider.value === slider.max) slider.value = '0';
    draw();
    play.textContent = 'Pause';
    timer = setInterval(() => {
      if (slider.value === slider.max) return stop();
      slider.stepUp();
      draw();
    }, 520);
  });
  draw();
  return sequence => {
    const index = frames.findIndex(frame => frame.sequence === sequence);
    if (index < 0) return;
    stop();
    slider.value = String(index);
    draw();
    document.querySelector('#location').focus();
  };
}

function renderMilestones(journey, seek) {
  const list = document.querySelector('#milestones');
  const milestones = [
    ...journey.decisions.map(({ location, choice }) => ({
      location, label: choice,
    })),
    ...journey.highlights.map(({ name, sequence }) => ({
      location: name, label: 'Boss cleared', sequence,
    })),
  ];
  list.replaceChildren(...milestones.map(({ location, label, sequence }) => {
    const row = document.createElement('li');
    const heading = document.createElement('strong');
    heading.textContent = location;
    const detail = document.createElement('span');
    detail.textContent = label;
    row.append(heading, detail);
    if (seek && journey.frames.some(frame => frame.sequence === sequence)) {
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.textContent = 'View in Replay';
      jump.setAttribute('aria-label', location + ' · View in Replay');
      jump.addEventListener('click', () => seek(sequence));
      row.append(jump);
    }
    return row;
  }));
  document.querySelector('#milestone-empty').hidden = Boolean(milestones.length);
}

control.addEventListener('click', async () => {
  const notice = document.querySelector('#challenge-status');
  control.disabled = true;
  notice.textContent = 'Preparing the route…';
  const start = () => fetch(path + '/challenge', { method: 'POST' });
  try {
    let response = await start();
    if (response.status === 401) {
      const guest = await fetch('/api/guest', { method: 'POST' });
      if (!guest.ok) throw new Error('Unable to open a guest session');
      response = await start();
    }
    if (!response.ok) throw new Error('Route unavailable');
    const { runId } = await response.json();
    location.assign('/?expedition=' + encodeURIComponent(runId));
  } catch {
    notice.textContent = 'The route could not be opened. Please try again.';
    control.disabled = false;
  }
});

try {
  const response = await fetch(path);
  if (!response.ok) throw new Error('Journey unavailable');
  const journey = await response.json();
  status.textContent = journey.outcome === 'won' ? 'Expedition cleared' : 'Expedition ended';
  const detail = document.querySelector('#journey-details');
  const talisman = { gate: 'Gate Talisman', river: 'River Talisman', lantern: 'Lantern Talisman' };
  const total = journey.frames?.length ?? 0;
  detail.textContent = [
    Object.hasOwn(talisman, journey.talisman) ? talisman[journey.talisman] : null,
    total ? total + (total === 1 ? ' recorded action' : ' recorded actions') : null,
  ].filter(Boolean).join(' · ');
  renderMilestones(journey, renderReplay(journey.frames));
  document.querySelector('#journey-summary').hidden = false;
  control.hidden = false;
  document.querySelector('#challenge-note').hidden = false;
  document.querySelector('#proof').textContent = 'Verified run digest · ' + journey.digest;
} catch {
  status.textContent = 'This expedition record is unavailable.';
}
