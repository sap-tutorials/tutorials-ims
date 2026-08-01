// Faithful legacy level->placement mapping (srv/routes/devtoberfest.js buildAvatar).
// bounceClass maps to a CSS class that sets bounce-7 iteration = level (avatar-4 = infinite).
export function sceneMap(level: number): { cloud: number; bounceClass: string; hearts: number } {
  const lvl = Math.min(4, Math.max(0, Math.floor(level || 0)))
  const bounceClass = ['avatar-1', 'avatar-1', 'avatar-2', 'avatar-3', 'avatar-4'][lvl]
  const hearts = lvl === 4 ? 0 : lvl   // level 4 shows the server lights, not hearts
  return { cloud: lvl, bounceClass, hearts }
}
export function avatarFile(imgBase: string, avatarIndex: number): string {
  const idx = Math.min(37, Math.max(0, Math.floor(avatarIndex || 0)))
  return `${imgBase}/avatars/Group-${idx}.png`
}
