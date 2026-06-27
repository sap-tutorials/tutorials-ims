<script setup lang="ts">
import { computed } from 'vue';
import type { Advocate } from '../shared/advocate-types';
import InitialsAvatar from './InitialsAvatar.vue';
import { useFlipCard } from '../composables/useFlipCard';

const props = defineProps<{ advocate: Advocate; photoBase: string }>();
const { flipped, cardEl, toggle } = useFlipCard();

const photoUrl = computed(() => {
  if (!props.advocate.hasPhoto) return null;
  const v = props.advocate.photoUpdatedAt ? '?v=' + encodeURIComponent(props.advocate.photoUpdatedAt) : '';
  return `${props.photoBase}/${props.advocate.slug}/photo${v}`;
});

const profileUrl = computed(() => `/developer-advocates/${props.advocate.slug}/`);

const ICON: Record<string, string> = {
  LinkedIn: 'in', X: '𝕏', GitHub: 'gh', YouTube: '▶',
  BlueSky: 'B', Mastodon: 'M', Blog: 'B+', SapCommunity: 'SC', Email: '✉', Other: '·',
};
</script>

<template>
  <div
    ref="cardEl"
    class="adv-flipwrap"
    :class="{ 'is-flipped': flipped }"
    role="button"
    :tabindex="0"
    :aria-pressed="flipped"
    :aria-label="`Toggle details for ${advocate.firstName} ${advocate.lastName}`"
    @click="toggle"
  >
    <div class="adv-card-inner">
      <div class="adv-face adv-front">
        <div class="adv-hero" :data-region="advocate.region">
          <img v-if="photoUrl" class="adv-photo" :src="photoUrl"
               :alt="`Photo of ${advocate.firstName} ${advocate.lastName}`"
               loading="lazy" />
          <InitialsAvatar v-else :first-name="advocate.firstName" :last-name="advocate.lastName" />
        </div>
        <div class="adv-body">
          <h3 class="adv-name">
            {{ advocate.firstName }} {{ advocate.lastName }}
            <span v-if="advocate.pronouns" class="adv-pron">({{ advocate.pronouns }})</span>
          </h3>
          <div class="adv-role" v-if="advocate.title">{{ advocate.title }}</div>
          <div class="adv-loc" v-if="advocate.location">{{ advocate.location }} · {{ advocate.region }}</div>
          <div class="adv-chips" v-if="advocate.topics.length">
            <span class="adv-chip" v-for="t in advocate.topics" :key="t.slug">{{ t.label }}</span>
          </div>
          <div class="adv-legend">hover to flip</div>
        </div>
      </div>
      <div class="adv-face adv-back">
        <h3 class="adv-name">{{ advocate.firstName }} {{ advocate.lastName }}</h3>
        <div class="adv-role">{{ advocate.title }} · {{ advocate.region }}</div>
        <div class="adv-bio">{{ advocate.bio || '' }}</div>
        <!-- Spec 2026-06-25-advocate-user-link-design §3: mailto and
             tutorial-count pill, both gated on the optional fields the
             public /api/advocates emits only when the advocate is linked
             to a User. Hidden entirely for unlinked advocates. -->
        <a
          v-if="advocate.email"
          class="adv-email-link"
          :href="`mailto:${advocate.email}`"
          @click.stop
        >
          ✉ {{ advocate.email }}
        </a>
        <div
          v-if="advocate.authoredTutorials?.length || advocate.contributedTutorials?.length"
          class="adv-tutorials-pill"
        >
          <template v-if="advocate.authoredTutorials?.length">
            {{ advocate.authoredTutorials.length }} authored
          </template>
          <template
            v-if="advocate.authoredTutorials?.length && advocate.contributedTutorials?.length"
          >
            ·
          </template>
          <template v-if="advocate.contributedTutorials?.length">
            {{ advocate.contributedTutorials.length }} contributed
          </template>
        </div>
        <div class="adv-links">
          <a v-for="l in advocate.links" :key="l.kind + l.url"
             class="adv-iconbtn"
             :href="l.url" target="_blank" rel="noopener"
             :title="l.label || l.kind">
            {{ ICON[l.kind] || l.kind.slice(0,2) }}
          </a>
        </div>
        <a v-if="profileUrl" class="adv-profile" :href="profileUrl">
          View profile →
        </a>
      </div>
    </div>
  </div>
</template>
