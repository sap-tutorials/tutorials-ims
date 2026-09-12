// srv/lib/ktt/banter.js
// Fail-open Kasimir banter helper.  Pure, no DB, no direct AI import — the
// caller (ktt-service.js init()) passes in an `ai` adapter so this module
// remains testable without any CAP service binding.

const FALLBACKS = {
  streak: "Purr-fect. Another one mastered — my nap is well earned.",
  wrong: "A miss! Even I cough up the occasional hairball. Try again.",
  correct: "Correct. You may pet me. Once.",
  default: "Acronyms: SAP's favorite indoor sport.",
};
const MAX_LEN = 160;

/** ai: object with async chat(prompt) → string, or null. Never throws. */
export async function computeBanter(ai, ctx = {}) {
  const fallback = FALLBACKS[ctx.event] || FALLBACKS.default;
  if (!ai || typeof ai.chat !== 'function') return fallback;
  try {
    const prompt = `You are Professor Kasimir, a witty SAP cat. One short, tongue-in-cheek line (<160 chars) for event "${ctx.event}". No emojis.`;
    const out = await Promise.race([
      ai.chat(prompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
    ]);
    const line = String(out || '').trim().slice(0, MAX_LEN);
    return line || fallback;
  } catch {
    return fallback;
  }
}
