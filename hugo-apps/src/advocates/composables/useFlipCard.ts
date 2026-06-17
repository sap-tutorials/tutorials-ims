import { onBeforeUnmount, onMounted, ref } from 'vue';

export function useFlipCard() {
  const flipped = ref(false);
  const cardEl  = ref<HTMLElement | null>(null);

  function toggle() { flipped.value = !flipped.value; }
  function unflip() { flipped.value = false; }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'Escape' && flipped.value) {
      unflip();
      cardEl.value?.focus();
    }
  }

  onMounted(() => cardEl.value?.addEventListener('keydown', onKey));
  onBeforeUnmount(() => cardEl.value?.removeEventListener('keydown', onKey));

  return { flipped, cardEl, toggle, unflip };
}
