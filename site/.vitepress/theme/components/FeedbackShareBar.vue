<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  title: string
  slug: string
  primaryTag?: string
  pageType?: 'tutorial' | 'mission' | 'group'
}>()

const feedbackOpen = ref(false)
const shareOpen = ref(false)

const pageUrl = computed(() => {
  const base = typeof window !== 'undefined' ? window.location.origin : ''
  const type = props.pageType ?? 'tutorial'
  if (type === 'mission') return `${base}/tutorials/mission-${props.slug}`
  if (type === 'group') return `${base}/tutorials/group-${props.slug}`
  return `${base}/tutorials/${props.slug}`
})

const communityUrl = computed(() => {
  const tag = props.primaryTag ?? ''
  const tagParam = tag ? `&primaryTagId=${encodeURIComponent(tag)}` : ''
  return `https://answers.sap.com/questions/ask.html?topics=tutorial-navigator${tagParam}&topics=tutorials-${props.slug}&b=${encodeURIComponent(`Tutorials: ${pageUrl.value}\n--------------------------\n\nWrite here what you need help with ...`)}`
})

const githubIssueUrl = computed(() => {
  return `https://github.com/sap-tutorials/Tutorials/issues/new?title=${encodeURIComponent(props.title)}&body=${encodeURIComponent(`Tutorials: ${pageUrl.value}\n--------------------------\n\nWrite here how you think we can improve the tutorial ...`)}`
})

const surveyUrl = computed(() => {
  return `https://sapinsights.eu.qualtrics.com/jfe/form/SV_0im30RgTkbEEHMV?TutorialID=${props.slug}&graphics=true`
})

const facebookUrl = computed(() => {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl.value)}`
})

const linkedinUrl = computed(() => {
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl.value)}`
})

const emailUrl = computed(() => {
  return `mailto:?subject=${encodeURIComponent(props.title)}&body=${encodeURIComponent(`Check out this SAP tutorial: ${pageUrl.value}`)}`
})

function openFeedback() {
  shareOpen.value = false
  feedbackOpen.value = true
}
function openShare() {
  feedbackOpen.value = false
  shareOpen.value = true
}
function closeAll() {
  feedbackOpen.value = false
  shareOpen.value = false
}
</script>

<template>
  <div class="action-bar">
    <div class="action-bar-inner">
      <div class="action-bar-nav">
        <slot name="nav-left" />
      </div>
      <div class="action-bar-actions">
        <button class="action-link" @click="openFeedback">
          <svg width="18" height="18" viewBox="0 0 32 32" fill="none"><path d="M12.06 18.98c-.37 0-.69-.13-.94-.39-.25-.29-.37-.62-.37-.98v-4.06H4.94c-.25 0-.47.1-.66.3-.19.19-.28.44-.28.73v6.8c0 .26.09.49.28.69.19.19.41.29.66.29h1.83c.03.1.05.23.05.39.03.13.03.33 0 .59-.09.55-.27.98-.52 1.27-.22.26-.33.39-.33.39s.28-.03.84-.1c.56-.07 1.06-.31 1.5-.74.31-.26.51-.57.61-.93.12-.36.19-.65.19-.88h7.55c.25 0 .47-.1.66-.29.19-.2.28-.43.28-.69v-2.4h-5.53zm14.77-11.98H12.86c-.31 0-.59.11-.84.34-.25.23-.38.52-.38.88v8.66c0 .33.11.62.33.88.25.23.55.34.89.34h8.86c.03.29.11.67.23 1.13.16.46.42.86.8 1.22.56.52 1.2.83 1.92.93.72.1 1.08.15 1.08.15s-.16-.18-.47-.54c-.28-.36-.48-.91-.61-1.66-.06-.26-.09-.49-.09-.69.03-.2.08-.37.14-.53h2.11c.31 0 .58-.11.8-.34.25-.23.38-.52.38-.88V8.22c0-.33-.11-.6-.33-.83-.22-.26-.5-.39-.84-.39z" fill="currentColor"/></svg>
          Feedback
        </button>
        <button class="action-link" @click="openShare">
          <svg width="18" height="18" viewBox="0 0 32 32" fill="none"><path d="M22.68 26c.91 0 1.69-.34 2.34-1.02.65-.68.98-1.52.98-2.5 0-.96-.33-1.78-.98-2.46-.65-.68-1.43-1.02-2.34-1.02-.5 0-.96.1-1.41.31-.44.2-.82.5-1.13.88l-7.54-3.77c.03-.05.04-.12.04-.2 0-.08.01-.15.04-.2-.03-.08-.04-.16-.04-.23 0-.07-.01-.14-.04-.21l7.54-3.77c.31.36.69.64 1.13.86.44.22.91.33 1.41.33.91 0 1.69-.34 2.34-1.02.65-.68.98-1.5.98-2.46 0-.98-.33-1.82-.98-2.5C24.37 6.34 23.59 6 22.68 6c-.91 0-1.7.34-2.36 1.02-.67.68-1 1.52-1 2.5 0 .11.01.21.02.31.01.1.03.2.06.31l-7.38 3.77c-.34-.44-.74-.78-1.21-1.03-.47-.25-.96-.37-1.48-.37-.91 0-1.69.34-2.34 1.02-.66.68-.99 1.5-.99 2.46s.33 1.78.99 2.46c.65.68 1.43 1.02 2.34 1.02.52 0 1.01-.12 1.48-.35.47-.23.87-.58 1.21-1.04l7.38 3.77c-.03.11-.05.21-.06.31-.01.1-.02.2-.02.31 0 .98.33 1.82 1 2.5.66.68 1.45 1.02 2.36 1.02z" fill="currentColor"/></svg>
          Share
        </button>
        <slot name="nav-right" />
      </div>
    </div>
  </div>

  <!-- Feedback popup -->
  <Teleport to="body">
    <div v-if="feedbackOpen" class="popup-overlay" @click.self="closeAll">
      <div class="popup-card">
        <button class="popup-close" @click="closeAll" aria-label="Close">&times;</button>
        <h3 class="popup-title">Feedback?</h3>
        <div class="feedback-options">
          <div class="feedback-option">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><path d="M18 28.5c-.56 0-1.03-.2-1.41-.59-.38-.44-.56-.93-.56-1.47v-6.09H7.41c-.38 0-.7.15-.98.44-.28.3-.43.67-.43 1.1v10.2c0 .39.14.72.42 1.03.28.29.63.44 1 .44h2.74c.05.15.07.34.07.59.05.2.05.49 0 .85-.14.83-.41 1.47-.79 1.91-.33.39-.5.59-.5.59s.42-.05 1.27-.15c.84-.1 1.59-.47 2.25-1.11.47-.39.72-.86.92-1.4.19-.54.28-1 .28-1.34h11.33c.38 0 .7-.15.98-.44.28-.29.43-.66.43-1.03V28.5H18zm22.15-18H14.29c-.47 0-.89.17-1.27.51-.37.34-.56.78-.56 1.32v12.99c0 .49.16.93.5 1.32.37.34.82.51 1.34.51h13.27c.05.44.17 1 .35 1.69.23.69.63 1.3 1.19 1.83.84.78 1.8 1.24 2.88 1.39 1.08.15 1.62.22 1.62.22s-.23-.27-.7-.81c-.42-.54-.73-1.37-.98-2.49-.09-.39-.14-.74-.14-1.03.05-.29.12-.56.21-.74h3.17c.47 0 .87-.17 1.19-.51.38-.34.56-.78.56-1.32V11.83c0-.49-.16-.91-.49-1.25-.33-.39-.75-.59-1.27-.59z" fill="#E8A400"/></svg>
            <span>Get help doing the tutorial</span>
            <a :href="communityUrl" target="_blank" rel="noopener" class="feedback-btn feedback-btn--blue">Ask the community</a>
          </div>
          <div class="feedback-option">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><path d="M24 8c-1.1 0-2 .45-2.7 1.35l-1.3 2c-.3.45-.6.7-1 .8l-2.3.5c-1.1.25-1.85.85-2.25 1.8-.4.95-.3 1.9.3 2.8l1.5 1.9c.3.35.4.75.35 1.15l-.25 2.4c-.1 1.1.2 2 .95 2.65.75.65 1.6.85 2.6.55l2.3-.7c.4-.15.8-.15 1.2 0l2.3.7c1 .3 1.85.1 2.6-.55.75-.65 1.05-1.55.95-2.65l-.25-2.4c-.05-.4.05-.8.35-1.15l1.5-1.9c.6-.9.7-1.85.3-2.8-.4-.95-1.15-1.55-2.25-1.8l-2.3-.5c-.4-.1-.7-.35-1-.8l-1.3-2C26 8.45 25.1 8 24 8zm0 28v4m-8-2l2-3.46M16 38l-2-3.46M32 38l-2-3.46m2 3.46l2-3.46" stroke="#E8A400" stroke-width="2" fill="none"/></svg>
            <span>Help improve the tutorial</span>
            <a :href="githubIssueUrl" target="_blank" rel="noopener" class="feedback-btn feedback-btn--orange">Contribute suggestion</a>
          </div>
          <div class="feedback-option">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><rect x="10" y="12" width="28" height="20" rx="2" stroke="#E8A400" stroke-width="2" fill="none"/><path d="M10 16l14 10 14-10" stroke="#E8A400" stroke-width="2" fill="none"/><path d="M18 36h12M22 36v-4h4v4" stroke="#E8A400" stroke-width="2" fill="none"/></svg>
            <span>Send us your thoughts</span>
            <a :href="surveyUrl" target="_blank" rel="noopener" class="feedback-btn feedback-btn--teal">Take our survey</a>
          </div>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Share popup -->
  <Teleport to="body">
    <div v-if="shareOpen" class="popup-overlay" @click.self="closeAll">
      <div class="popup-card popup-card--share">
        <button class="popup-close" @click="closeAll" aria-label="Close">&times;</button>
        <h3 class="popup-title">Share this {{ pageType ?? 'tutorial' }}</h3>
        <div class="share-icons">
          <a :href="facebookUrl" target="_blank" rel="noopener" class="share-icon share-icon--facebook" title="Share on Facebook">
            <svg width="32" height="32" viewBox="0 0 32 32"><path d="M18.4 32V17.4h4.9l.7-5.7h-5.6V8.1c0-1.6.5-2.8 2.8-2.8h3V.2C23.5.1 21.8 0 19.8 0c-4.1 0-6.9 2.5-6.9 7.1v4.2H8v5.7h4.9V32h5.5z" fill="#1877F2"/></svg>
          </a>
          <a :href="linkedinUrl" target="_blank" rel="noopener" class="share-icon share-icon--linkedin" title="Share on LinkedIn">
            <svg width="32" height="32" viewBox="0 0 32 32"><path d="M29.6 0H2.4C1.1 0 0 1 0 2.3v27.4C0 31 1.1 32 2.4 32h27.2c1.3 0 2.4-1 2.4-2.3V2.3C32 1 30.9 0 29.6 0zM9.5 27.3H4.7V12h4.8v15.3zM7.1 9.9c-1.5 0-2.8-1.2-2.8-2.8 0-1.5 1.2-2.8 2.8-2.8 1.5 0 2.8 1.2 2.8 2.8 0 1.6-1.3 2.8-2.8 2.8zm20.2 17.4h-4.8v-7.4c0-1.8 0-4-2.5-4s-2.8 1.9-2.8 3.9v7.6h-4.8V12h4.6v2.1h.1c.6-1.2 2.2-2.5 4.5-2.5 4.8 0 5.7 3.2 5.7 7.3v8.4z" fill="#0A66C2"/></svg>
          </a>
          <a :href="emailUrl" class="share-icon share-icon--email" title="Share via Email">
            <svg width="32" height="32" viewBox="0 0 32 32"><rect x="2" y="6" width="28" height="20" rx="2" fill="#E8A400"/><path d="M2 8l14 10L30 8" stroke="#fff" stroke-width="2" fill="none"/></svg>
          </a>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.action-bar {
  background: var(--sapShellColor, #354a5f);
  padding: 0.625rem 0;
}
.action-bar-inner {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 2rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.action-bar-actions {
  display: flex;
  align-items: center;
  gap: 1.5rem;
}
.action-link {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  background: none;
  border: none;
  color: var(--sapShell_TextColor, #fff);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  opacity: 0.9;
  padding: 0;
  font-family: inherit;
}
.action-link:hover { opacity: 1; }
.action-link svg { flex-shrink: 0; }

/* Popup overlay */
.popup-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.popup-card {
  background: #fff;
  border-radius: 0.75rem;
  padding: 2rem 2.5rem;
  max-width: 640px;
  width: 90%;
  position: relative;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
}
.popup-card--share {
  max-width: 400px;
  text-align: center;
}
.popup-close {
  position: absolute;
  top: 0.75rem;
  right: 1rem;
  background: none;
  border: none;
  font-size: 1.5rem;
  color: var(--sapNeutralTextColor, #6a6d70);
  cursor: pointer;
  padding: 0.25rem;
  line-height: 1;
}
.popup-close:hover { color: var(--sapTextColor, #32363a); }
.popup-title {
  font-size: 1.25rem;
  font-weight: 700;
  margin: 0 0 1.5rem;
  color: var(--sapTextColor, #32363a);
}

/* Feedback options */
.feedback-options {
  display: flex;
  gap: 1.5rem;
}
.feedback-option {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.75rem;
}
.feedback-option span {
  font-size: 0.8125rem;
  color: var(--sapNeutralTextColor, #6a6d70);
  line-height: 1.4;
}
.feedback-btn {
  display: inline-block;
  padding: 0.5rem 1rem;
  border-radius: 0.375rem;
  color: #fff;
  text-decoration: none;
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
  transition: opacity 0.15s;
}
.feedback-btn:hover { opacity: 0.85; color: #fff; }
.feedback-btn--blue { background: #0070f2; }
.feedback-btn--orange { background: #e76500; }
.feedback-btn--teal { background: #0a7e8c; }

/* Share icons */
.share-icons {
  display: flex;
  justify-content: center;
  gap: 1rem;
  margin-top: 1rem;
}
.share-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  transition: transform 0.15s;
}
.share-icon:hover { transform: scale(1.1); }

@media (max-width: 640px) {
  .feedback-options { flex-direction: column; gap: 1rem; }
  .popup-card { padding: 1.5rem; }
}
</style>
