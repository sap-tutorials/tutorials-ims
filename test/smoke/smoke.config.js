export const BASE_URL = (process.env.SMOKE_BASE_URL || 'http://localhost:4004').replace(/\/$/, '');
export const SRV_URL = (process.env.SMOKE_SRV_URL || BASE_URL).replace(/\/$/, '');
export const TECH_USER = process.env.SMOKE_TECH_USER;
export const TECH_PASSWORD = process.env.SMOKE_TECH_PASSWORD;

export function authHeader() {
  if (!TECH_USER || !TECH_PASSWORD) return undefined;
  return 'Basic ' + Buffer.from(`${TECH_USER}:${TECH_PASSWORD}`).toString('base64');
}

export async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { ...options, redirect: 'manual' });
      return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}
