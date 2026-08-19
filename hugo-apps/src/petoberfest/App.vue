<!-- hugo-apps/src/petoberfest/App.vue -->
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { fetchSlideshow, fetchMyUploads, uploadPet, probeAuth, photoUrl,
         type SlideEntry, type MyUpload } from './lib/server';

const props = defineProps<{ slug: string }>();
const slides = ref<SlideEntry[]>([]);
const mine = ref<MyUpload[]>([]);
const loggedIn = ref(false);
const idx = ref(0);
const petName = ref('');
const file = ref<File | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const status = ref<string>('');
const busy = ref(false);
const paused = ref(false);

let timer: number | undefined;

// Fisher–Yates shuffle (returns a new array). The slideshow order is randomized
// on each mount so visitors don't always see the newest uploads first.
function shuffle<T>(arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function startTimer() {
  if (timer !== undefined) { clearInterval(timer); timer = undefined; }
  if (slides.value.length > 1) {
    timer = window.setInterval(() => { if (!paused.value) advance(); }, 5000);
  }
}
function advance() { if (slides.value.length) idx.value = (idx.value + 1) % slides.value.length; }
function next() {
  if (!slides.value.length) return;
  idx.value = (idx.value + 1) % slides.value.length;
  if (!paused.value) startTimer();          // full interval after manual step
}
function prev() {
  if (!slides.value.length) return;
  idx.value = (idx.value - 1 + slides.value.length) % slides.value.length;
  if (!paused.value) startTimer();
}
function goTo(i: number) {
  if (i < 0 || i >= slides.value.length) return;
  idx.value = i;
  if (!paused.value) startTimer();
}
function togglePlay() { paused.value = !paused.value; }

onMounted(async () => {
  slides.value = shuffle(await fetchSlideshow(props.slug));
  startTimer();
  loggedIn.value = await probeAuth();
  if (loggedIn.value) mine.value = await fetchMyUploads(props.slug);
});

onUnmounted(() => { if (timer !== undefined) clearInterval(timer); });

function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0] || null;
  if (f && !/^image\//.test(f.type)) {
    status.value = 'Please choose an image file under 10 MB.'; file.value = null; return;
  }
  if (f && f.size > 10 * 1024 * 1024) {
    status.value = 'Please choose an image file under 10 MB.'; file.value = null; return;
  }
  file.value = f; status.value = '';
}

async function submit() {
  if (!file.value) { status.value = 'Choose a photo first.'; return; }
  busy.value = true; status.value = '';
  try {
    const res = await uploadPet(props.slug, file.value, petName.value);
    status.value = res.awarded
      ? 'Your pet is uploaded — pending approval 🐾 You earned your Petoberfest points!'
      : 'Your pet is uploaded — pending approval 🐾';
    petName.value = ''; file.value = null;
    if (fileInput.value) fileInput.value.value = '';
    mine.value = await fetchMyUploads(props.slug);
  } catch (e: any) {
    status.value = e.code === 'DUPLICATE' || e.status === 409 ? 'You already uploaded that photo.' : (e.message || 'Upload failed.');
  } finally { busy.value = false; }
}

defineExpose({ idx, paused, next, prev, goTo, togglePlay });
</script>

<template>
  <section class="pet-slideshow" v-if="slides.length">
    <div class="pet-titleband">🐾 Petoberfest 🐾</div>
    <div class="pet-frame">
      <button class="pet-nav pet-nav--prev" @click="prev" aria-label="Previous pet">‹</button>
      <div class="pet-stage">
        <img :src="photoUrl(slides[idx].id, 'display')" :alt="slides[idx].petName || 'pet'" />
      </div>
      <button class="pet-nav pet-nav--next" @click="next" aria-label="Next pet">›</button>
      <p class="pet-caption">
        <strong>{{ slides[idx].petName || 'A good pet' }}</strong>
        <span v-if="slides[idx].uploaderName"> — {{ slides[idx].uploaderName }}</span>
      </p>
    </div>
    <div class="pet-controls">
      <button class="pet-play" @click="togglePlay"
              :aria-label="paused ? 'Play slideshow' : 'Pause slideshow'">
        {{ paused ? '▶' : '⏸' }}
      </button>
      <div class="pet-dots">
        <button v-for="(s, i) in slides" :key="s.id"
                class="pet-dot" :class="{ 'pet-dot--active': i === idx }"
                @click="goTo(i)" :aria-label="`Go to pet ${i + 1}`"></button>
      </div>
    </div>
  </section>
  <p v-else class="pet-empty">No pets yet — be the first! 🐾</p>

  <section class="pet-upload">
    <template v-if="loggedIn">
      <h2>Add your pet</h2>
      <input ref="fileInput" type="file" accept="image/*" @change="onPick" :disabled="busy" />
      <input type="text" v-model="petName" maxlength="120" placeholder="Pet name / caption" :disabled="busy" />
      <button @click="submit" :disabled="busy || !file">Upload</button>
      <p class="pet-status" v-if="status">{{ status }}</p>
      <div v-if="mine.length" class="pet-mine">
        <h3>Your pets</h3>
        <ul><li v-for="m in mine" :key="m.id">{{ m.petName || 'Pet' }} — {{ m.moderation === 'APPROVED' ? 'live' : 'pending approval' }}</li></ul>
      </div>
    </template>
    <template v-else>
      <p>Want your pet in the slideshow? <a href="/login">Sign in to add your pet</a>.</p>
    </template>
  </section>
</template>

<style scoped>
.pet-slideshow { max-width: 720px; margin: 1.5rem auto; text-align: center; }
.pet-titleband {
  font-size: 1.4rem; font-weight: 700; letter-spacing: .02em;
  color: #7a3e00; margin-bottom: .5rem;
}
.pet-frame {
  position: relative; background: #fff8f0;
  border: 1px solid #e8d3b8; border-radius: 16px;
  box-shadow: 0 6px 24px rgba(122, 62, 0, .12);
  padding: 12px 12px 8px; overflow: hidden;
}
/* Fixed-aspect stage: image letterboxed, never reflows the page. */
.pet-stage {
  aspect-ratio: 16 / 10; max-height: 60vh;
  display: flex; align-items: center; justify-content: center;
  background: #2b2b2b; border-radius: 10px; overflow: hidden;
}
.pet-stage img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
.pet-caption {
  margin: .6rem 0 .2rem; color: #5a4632; font-size: 1rem;
}
.pet-nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  z-index: 2; border: none; cursor: pointer;
  width: 40px; height: 40px; border-radius: 50%;
  background: rgba(255,255,255,.85); color: #7a3e00;
  font-size: 1.6rem; line-height: 1;
  box-shadow: 0 2px 6px rgba(0,0,0,.2);
}
.pet-nav--prev { left: 18px; }
.pet-nav--next { right: 18px; }
.pet-nav:hover { background: #fff; }
.pet-controls {
  display: flex; align-items: center; justify-content: center;
  gap: 1rem; margin-top: .75rem;
}
.pet-play {
  border: none; cursor: pointer; width: 36px; height: 36px;
  border-radius: 50%; background: #d97706; color: #fff; font-size: 1rem;
}
.pet-dots { display: flex; gap: .4rem; }
.pet-dot {
  width: 10px; height: 10px; border-radius: 50%; border: none; padding: 0;
  cursor: pointer; background: #e0c3a0;
}
.pet-dot--active { background: #d97706; }
.pet-empty { text-align: center; color: #7a3e00; margin: 2rem 0; font-size: 1.1rem; }
</style>
