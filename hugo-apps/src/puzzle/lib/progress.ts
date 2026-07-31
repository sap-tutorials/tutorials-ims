export function shouldMigrate(
  authed: boolean,
  serverGrid: string | null,
  localGrid: Record<string, string>
): boolean {
  if (!authed) return false;
  let server: Record<string, string> = {};
  try { server = serverGrid ? JSON.parse(serverGrid) : {}; } catch { server = {}; }
  const serverHas = Object.values(server).some(v => v && v.length > 0);
  if (serverHas) return false;
  return Object.values(localGrid || {}).some(v => v && v.length > 0);
}

export function emptyWhiteCells(
  grid: ReadonlyArray<ReadonlyArray<{ black?: boolean }>>,
  answers: Readonly<Record<string, string>>
): Array<{ r: number; c: number }> {
  const out: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c].black) continue;
      if (!answers[`${r},${c}`]) out.push({ r, c });
    }
  }
  return out;
}
