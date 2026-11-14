// Each beat snapshots its affected slots. Counterplay can move, mitigate or cancel a beat.
export const actions = {
  netkeeper: { basic: 'Weighted Cast', color: '#97a37c' },
  'bell-drowned-elite': { basic: 'Anchor Backhand', color: '#7fbfd3' },
  'bell-drowned': {
    basic: 'Anchor Lash', color: '#79c9df', combo: 'Last Crossing',
    hint: 'Switch the marked front slots before the sweep, then break an anchor to weaken the final surge.',
    beats: [[.76, 'Toll Mark', [0, 1]], [1.54, 'Chain Sweep', [0, 1]], [2.66, 'Drowned Surge', [0, 1, 2, 3]]],
    counter: [[], [], [0, 1, 2, 3]], outcomes: ['Marked', 'Swapped clear', 'Anchor broken · reduced impact'],
  },
  'mother-of-closed-doors': {
    basic: 'Root Scythe', color: '#a4c27b', combo: 'Three Doors Close',
    hint: 'Separate the linked heroes, then strike the bud with the pale hinge before the doors close.',
    beats: [[.74, 'Root Gate', [1]], [1.58, 'Graft Link', [1, 2]], [2.74, 'Three Door Buds', [0, 1, 2, 3]]],
    counter: [[1], [], []], outcomes: ['Root Gate holds', 'Link broken', 'Hinge bud destroyed · interrupted'],
  },
  'kiln-that-hungers': {
    basic: 'Furnace Snap', color: '#ff8147', combo: 'Consume Heat',
    hint: 'Move away from the vents, then apply Wet during the two-step charge to dampen the last blast.',
    beats: [[.8, 'Vent Burst', [0, 2]], [1.66, 'Gather Heat', [1, 3]], [2.85, 'Consume Heat', [0, 1, 2, 3]]],
    counter: [[], [], [0, 1, 2, 3]], outcomes: ['Vent lane cleared', 'Heat gathers', 'Wet · reduced impact'],
  },
  'iron-procession': {
    basic: 'Blade Rake', color: '#c8c9ff', combo: 'Final Toll',
    hint: 'Pressure the Front Car when the guard changes, then swap out of the two nonadjacent toll slots.',
    beats: [[.7, 'Front Car Rake', [0, 1]], [1.42, 'Guard Reversal', [1, 2]], [2.58, 'Final Toll', [0, 2]]],
    counter: [[0, 1], [1], []], outcomes: ['Front Car Rake lands', 'Guard broken', 'Toll slots cleared'],
  },
  'buried-magistrate': {
    basic: 'Gravestone Claw', color: '#e1ad65', combo: 'Stone Decree',
    hint: 'Keep the Stay slot occupied, move the condemned hero, then use Ward against the verdict.',
    beats: [[.77, 'Stay Verdict', [0]], [1.62, 'Move Verdict', [3]], [2.72, 'Stone Decree', [0, 1, 2, 3]]],
    counter: [[], [], [0, 1, 2, 3]], outcomes: ['Stayed safely', 'Condemned slot cleared', 'Ward · reduced impact'],
  },
};
