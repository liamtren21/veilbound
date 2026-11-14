// ARM64 Dash.Common.Random, constructor mixer and Next.
export function mixSeed(seed){
  seed^=seed<<13;
  seed^=seed>>7;
  return (seed^(seed<<17))|0;
}

export function nextSeed(seed){
  seed^=seed<<13;
  seed^=seed>>17;
  return (seed^(seed<<5))|0;
}

export function battleRng(seed){
  const root=mixSeed(seed||1);
  const events=nextSeed(root);
  const dice=nextSeed(events);
  const effects=nextSeed(dice);
  return {dice:mixSeed(dice),effects:mixSeed(effects)};
}

export function pickFromStream(streams,key,values){
  if(!values.length)return undefined;
  const seed=nextSeed(streams[key]);
  streams[key]=seed;
  return values[Math.abs(seed)%values.length];
}

// Keep the visible rolled face first without duplicating other faces.
export function displayFaces(face,pool){
  return [...new Set([face,...pool])].slice(0,6);
}
