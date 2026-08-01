import { ref } from 'vue'
// Audio starts MUTED with no autoplay (browser policy + a11y). The user opts in.
export function useSound(src: string, factory: () => HTMLAudioElement = () => new Audio(src)) {
  const enabled = ref(false)
  let audio: HTMLAudioElement | null = null
  function toggle() {
    if (!audio) { audio = factory(); audio.loop = true }
    if (enabled.value) { audio.pause(); enabled.value = false }
    else { audio.muted = false; void audio.play(); enabled.value = true }
  }
  return { enabled, toggle }
}
