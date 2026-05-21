import { createApp, h } from 'vue';
import TutorialFeedbackForm from './TutorialFeedbackForm.vue';

export function mount(slug: string, popupId: string) {
  const mountId = 'tutorial-feedback-mount';
  const el = document.getElementById(mountId);
  if (!el || el.dataset.mounted) return;
  el.dataset.mounted = '1';

  const close = () => {
    const popup = document.getElementById(popupId);
    if (popup) popup.classList.add('popup-hidden');
  };

  createApp({
    render: () => h(TutorialFeedbackForm, { slug, onClose: close })
  }).mount(el);
}

(window as any).mountTutorialFeedback = mount;
