import { createApp } from 'vue'
import CodeCheck from './CodeCheck.vue'

document.querySelectorAll('.step-codecheck-mount').forEach((el) => {
  const ds = (el as HTMLElement).dataset
  let hints: string[] = []
  try { hints = JSON.parse(ds.hints || '[]') } catch { /* ignore */ }
  createApp(CodeCheck, {
    slug: ds.slug || '',
    stepNumber: Number(ds.step || 0),
    goal: ds.goal || '',
    language: ds.language || '',
    hints,
    hasReference: ds.hasReference === 'true'
  }).mount(el as HTMLElement)
})
