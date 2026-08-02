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

let timer: number | undefined;
function advance() { if (slides.value.length) idx.value = (idx.value + 1) % slides.value.length; }

onMounted(async () => {
  slides.value = await fetchSlideshow(props.slug);
  if (slides.value.length > 1) timer = window.setInterval(advance, 5000);
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
</script>

<template>
  <section class="pet-slideshow">
    <div v-if="slides.length" class="pet-slide">
      <img :src="photoUrl(slides[idx].id, 'display')" :alt="slides[idx].petName || 'pet'" />
      <p class="pet-caption">
        <strong>{{ slides[idx].petName || 'A good pet' }}</strong>
        <span v-if="slides[idx].uploaderName"> — {{ slides[idx].uploaderName }}</span>
      </p>
    </div>
    <p v-else class="pet-empty">No pets yet — be the first! 🐾</p>
  </section>

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
