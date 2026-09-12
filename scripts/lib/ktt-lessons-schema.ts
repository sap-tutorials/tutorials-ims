export interface KttAcronym { tla: string; expansion: string; blurb: string; category: string; }
export interface KttDrill {
  type: 'drill'; kind: 'mc' | 'match' | 'type'; tla: string; prompt: string;
  answer: string; distractors: string[]; kasimirRight: string; kasimirWrong: string;
}
export interface KttStory { type: 'story'; kasimir: string; mood: 'idle'|'teaching'|'thinking'|'correct'|'wrong'|'celebrate'; }
export type KttBeat = KttStory | KttDrill;
export interface KttLesson { id: string; legacyId: number; title: string; acronyms: KttAcronym[]; beats: KttBeat[]; }
export interface KttUnit { id: string; title: string; icon: string; order: number; lessons: KttLesson[]; }
export interface KttData { units: KttUnit[]; }

export function validateLessons(data: KttData): string[] {
  const errs: string[] = [];
  const legacyIds = new Set<number>();
  for (const u of data.units || []) {
    for (const l of u.lessons || []) {
      if (typeof l.legacyId !== 'number') errs.push(`${l.id}: missing numeric legacyId`);
      if (legacyIds.has(l.legacyId)) errs.push(`${l.id}: duplicate legacyId ${l.legacyId}`);
      legacyIds.add(l.legacyId);
      for (const a of l.acronyms || []) if (!a.expansion) errs.push(`${l.id}/${a.tla}: missing expansion`);
      for (const b of l.beats || []) {
        if (b.type === 'drill') {
          if (!b.answer) errs.push(`${l.id}: drill for ${b.tla} missing answer`);
          if (!b.distractors || b.distractors.length < 2) errs.push(`${l.id}: drill for ${b.tla} needs >=2 distractors`);
        }
      }
    }
  }
  return errs;
}
