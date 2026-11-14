export function runItemProvenance(mode, { tutorial = false } = {}) {
  if (tutorial) return 'tutorial';
  if (mode === 'expedition') return 'expedition-run';
  return mode;
}

export function canExportItem(provenance) {
  return provenance === 'settled';
}

