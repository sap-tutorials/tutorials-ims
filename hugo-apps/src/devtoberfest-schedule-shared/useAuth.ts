import { ref, onMounted, onUnmounted, type Ref } from 'vue';

export function useAuth(): { isAuthenticated: Ref<boolean> } {
  const isAuthenticated = ref(document.documentElement.dataset.authenticated === 'true');
  const onResolved = () => { isAuthenticated.value = document.documentElement.dataset.authenticated === 'true'; };
  onMounted(() => document.addEventListener('auth-resolved', onResolved));
  onUnmounted(() => document.removeEventListener('auth-resolved', onResolved));
  return { isAuthenticated };
}
