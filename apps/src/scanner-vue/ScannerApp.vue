<script setup lang="ts">
import { ref, computed } from 'vue'
import { useBarcodeScanner } from './useBarcodeScanner'
import { useScannerApi } from './useScannerApi'
import type { ScanResult, ContestantData } from './types'

const videoRef = ref<HTMLVideoElement | null>(null)
const { scan, cancel, isSupported, isScanning, error: scanError } = useBarcodeScanner(videoRef)
const { loading, getContestant, claimPrize, reset: resetApi } = useScannerApi()

type AppState = 'idle' | 'scanning' | 'loaded' | 'claiming'
const state = ref<AppState>('idle')
const contestant = ref<ContestantData | null>(null)
const toast = ref<{ message: string; type: 'success' | 'error' } | null>(null)
const manualInput = ref('')
const errorMessage = ref<string | null>(null)

const showManualInput = computed(() => !isSupported.value)

function showToast(message: string, type: 'success' | 'error' = 'success') {
  toast.value = { message, type }
  setTimeout(() => { toast.value = null }, 2500)
}

function resetState() {
  contestant.value = null
  errorMessage.value = null
  state.value = 'idle'
  resetApi()
}

function parseScanData(text: string): ScanResult {
  const data = JSON.parse(text)
  if (!data.uid) throw new Error('Missing uid in barcode data')
  return {
    uid: String(data.uid),
    payload: {
      recordId: data.payload?.recordId ? String(data.payload.recordId) : '',
      status: data.payload?.status || ''
    }
  }
}

async function loadContestant(scanResult: ScanResult) {
  state.value = 'loaded'
  try {
    const data = await getContestant(scanResult.uid)
    contestant.value = {
      uid: scanResult.uid,
      recordId: scanResult.payload.recordId,
      status: scanResult.payload.status,
      tutorialsCompleted: data.tutorialsCompleted,
      groupsCompleted: data.groupsCompleted,
      missionsCompleted: data.missionsCompleted,
      prizeRecords: data.prizeRecords
    }
  } catch (e) {
    errorMessage.value = `Could not load contestant: ${(e as Error).message}`
    state.value = 'idle'
  }
}

async function onScan() {
  errorMessage.value = null
  state.value = 'scanning'

  const result = await scan()
  if (!result) {
    if (scanError.value) {
      errorMessage.value = scanError.value
    }
    state.value = 'idle'
    return
  }

  try {
    const scanResult = parseScanData(result)
    await loadContestant(scanResult)
  } catch (e) {
    errorMessage.value = `Invalid barcode: ${(e as Error).message}`
    state.value = 'idle'
  }
}

async function onManualLookup() {
  errorMessage.value = null
  const text = manualInput.value.trim()
  if (!text) return

  try {
    const scanResult = parseScanData(text)
    await loadContestant(scanResult)
  } catch (e) {
    errorMessage.value = `Invalid input: ${(e as Error).message}`
  }
}

function onCancel() {
  cancel()
  state.value = 'idle'
  showToast('Scan cancelled', 'success')
}

async function onScanAgain() {
  resetState()
}

async function onClaimPrize() {
  if (!contestant.value?.recordId) {
    showToast('No prize record available', 'error')
    return
  }

  state.value = 'claiming'
  try {
    await claimPrize(contestant.value.recordId)
    showToast('Prize claimed!')
    // Refresh contestant data
    const scanResult: ScanResult = {
      uid: contestant.value.uid,
      payload: { recordId: contestant.value.recordId, status: contestant.value.status }
    }
    await loadContestant(scanResult)
  } catch (e) {
    errorMessage.value = `Could not claim prize: ${(e as Error).message}`
    state.value = 'loaded'
  }
}
</script>

<template>
  <div class="scanner-app">
    <!-- Toast notification -->
    <Transition name="toast">
      <div v-if="toast" class="scanner-toast" :class="'scanner-toast--' + toast.type">
        {{ toast.message }}
      </div>
    </Transition>

    <!-- Error banner -->
    <div v-if="errorMessage" class="fd-message-strip fd-message-strip--error scanner-error" role="alert">
      <p class="fd-message-strip__text">{{ errorMessage }}</p>
      <button class="fd-button fd-button--transparent fd-message-strip__close"
              aria-label="Close" @click="errorMessage = null">
        <i class="sap-icon--decline"></i>
      </button>
    </div>

    <!-- IDLE STATE -->
    <div v-if="state === 'idle'" class="scanner-idle">
      <div class="scanner-idle__icon">
        <i class="sap-icon--bar-code"></i>
      </div>
      <h2 class="scanner-idle__title">Badge Scanner</h2>
      <p class="scanner-idle__hint">Scan a contestant badge to view progress and claim prizes</p>

      <button v-if="isSupported" class="fd-button fd-button--emphasized scanner-btn-full"
              @click="onScan">
        <i class="sap-icon--camera"></i>
        <span>Scan Badge</span>
      </button>

      <!-- Manual input fallback -->
      <div v-if="showManualInput" class="scanner-manual">
        <p class="scanner-manual__label">Camera scanning not available. Paste badge JSON:</p>
        <textarea v-model="manualInput" class="fd-textarea scanner-manual__input"
                  placeholder='{"uid":"12345","payload":{"recordId":"67890","status":"ELIGIBLE"}}'
                  rows="3"></textarea>
        <button class="fd-button fd-button--emphasized scanner-btn-full" @click="onManualLookup">
          <i class="sap-icon--search"></i>
          <span>Look Up</span>
        </button>
      </div>
    </div>

    <!-- SCANNING STATE -->
    <div v-else-if="state === 'scanning'" class="scanner-camera">
      <div class="scanner-camera__viewfinder">
        <video ref="videoRef" class="scanner-camera__video" playsinline muted></video>
        <div class="scanner-camera__overlay">
          <div class="scanner-camera__frame"></div>
        </div>
      </div>
      <button class="fd-button fd-button--transparent scanner-camera__cancel" @click="onCancel">
        <i class="sap-icon--decline"></i>
        <span>Cancel</span>
      </button>
    </div>

    <!-- LOADED / CLAIMING STATE -->
    <div v-else-if="state === 'loaded' || state === 'claiming'" class="scanner-data">
      <div class="scanner-card" :class="{ 'scanner-card--busy': loading || state === 'claiming' }">
        <div v-if="loading || state === 'claiming'" class="scanner-card__busy">
          <div class="fd-busy-indicator fd-busy-indicator--m" aria-label="Loading">
            <div class="fd-busy-indicator__circle"></div>
            <div class="fd-busy-indicator__circle"></div>
            <div class="fd-busy-indicator__circle"></div>
          </div>
        </div>

        <template v-if="contestant">
          <!-- Identity -->
          <div class="scanner-card__header">
            <h3 class="scanner-card__uid">{{ contestant.uid }}</h3>
            <p class="scanner-card__meta">{{ contestant.recordId }} &middot; {{ contestant.status }}</p>
          </div>

          <!-- Prizes highlight -->
          <div class="scanner-card__prizes">
            <span class="scanner-card__prizes-label">Prizes</span>
            <span class="scanner-card__prizes-value">{{ contestant.prizeRecords }}</span>
          </div>

          <!-- Stats -->
          <ul class="fd-list scanner-card__stats" role="list">
            <li class="fd-list__item" role="listitem">
              <span class="fd-list__title">Tutorials Completed</span>
              <span class="fd-list__secondary">{{ contestant.tutorialsCompleted }}</span>
            </li>
            <li class="fd-list__item" role="listitem">
              <span class="fd-list__title">Groups Completed</span>
              <span class="fd-list__secondary">{{ contestant.groupsCompleted }}</span>
            </li>
            <li class="fd-list__item" role="listitem">
              <span class="fd-list__title">Missions Completed</span>
              <span class="fd-list__secondary">{{ contestant.missionsCompleted }}</span>
            </li>
          </ul>
        </template>
      </div>

      <!-- Footer bar -->
      <div class="fd-bar fd-bar--footer scanner-footer">
        <div class="fd-bar__right">
          <div class="fd-bar__element">
            <button class="fd-button fd-button--transparent" @click="onScanAgain">
              <i class="sap-icon--undo"></i>
              <span>Scan Again</span>
            </button>
          </div>
          <div class="fd-bar__element">
            <button class="fd-button fd-button--emphasized" @click="onClaimPrize"
                    :disabled="state === 'claiming' || !contestant?.recordId">
              <i class="sap-icon--gift"></i>
              <span>Claim Prize</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scanner-app {
  font-family: var(--sapFontFamily, '72', '72full', Arial, Helvetica, sans-serif);
  color: var(--sapTextColor, #32363a);
  background: var(--sapBackgroundColor, #f5f6f7);
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  touch-action: manipulation;
  overflow-x: hidden;
}

/* Toast */
.scanner-toast {
  position: fixed;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  padding: 0.75rem 1.5rem;
  border-radius: 0.5rem;
  font-weight: 600;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
.scanner-toast--success {
  background: var(--sapPositiveColor, #188918);
  color: #fff;
}
.scanner-toast--error {
  background: var(--sapNegativeColor, #b00);
  color: #fff;
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(-0.5rem); }

/* Error strip */
.scanner-error {
  margin: 0.75rem;
}

/* IDLE */
.scanner-idle {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem 1.5rem;
  gap: 1rem;
  text-align: center;
}
.scanner-idle__icon {
  font-size: 5rem;
  color: var(--sapContent_IconColor, #0a6ed1);
  margin-bottom: 0.5rem;
}
.scanner-idle__title {
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0;
  color: var(--sapTitleColor, #32363a);
}
.scanner-idle__hint {
  font-size: 0.875rem;
  color: var(--sapContent_LabelColor, #6a6d70);
  margin: 0 0 1rem;
  max-width: 280px;
}

/* Manual input */
.scanner-manual {
  width: 100%;
  max-width: 360px;
  margin-top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.scanner-manual__label {
  font-size: 0.8125rem;
  color: var(--sapContent_LabelColor, #6a6d70);
  margin: 0;
}
.scanner-manual__input {
  width: 100%;
  font-size: 0.8125rem;
}

/* Full-width button */
.scanner-btn-full {
  width: 100%;
  max-width: 360px;
  min-height: 3rem;
  font-size: 1rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}

/* SCANNING */
.scanner-camera {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #000;
}
.scanner-camera__viewfinder {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.scanner-camera__video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.scanner-camera__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.scanner-camera__frame {
  width: 240px;
  height: 240px;
  border: 3px solid rgba(255,255,255,0.7);
  border-radius: 1rem;
  box-shadow: 0 0 0 9999px rgba(0,0,0,0.4);
}
.scanner-camera__cancel {
  position: absolute;
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%);
  color: #fff !important;
  min-height: 3rem;
  font-size: 1rem;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

/* DATA STATE */
.scanner-data {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 1rem;
  gap: 1rem;
}
.scanner-card {
  background: var(--sapTile_Background, #fff);
  border: 1px solid var(--sapTile_BorderColor, #d9d9d9);
  border-radius: 0.75rem;
  overflow: hidden;
  position: relative;
}
.scanner-card--busy { opacity: 0.6; pointer-events: none; }
.scanner-card__busy {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5;
}
.scanner-card__header {
  padding: 1rem 1rem 0.5rem;
}
.scanner-card__uid {
  font-size: 1.25rem;
  font-weight: 700;
  margin: 0;
  color: var(--sapTitleColor, #32363a);
}
.scanner-card__meta {
  font-size: 0.8125rem;
  color: var(--sapContent_LabelColor, #6a6d70);
  margin: 0.25rem 0 0;
}

/* Prizes highlight */
.scanner-card__prizes {
  background: var(--sapInformationBackground, #e8f0fa);
  border-bottom: 2px solid var(--sapInformationBorderColor, #0a6ed1);
  padding: 0.75rem 1rem;
  margin: 0.5rem 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.scanner-card__prizes-label {
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--sapContent_LabelColor, #6a6d70);
}
.scanner-card__prizes-value {
  font-size: 0.875rem;
  white-space: pre-line;
}

/* Stats list */
.scanner-card__stats {
  margin: 0;
  border-top: 1px solid var(--sapList_BorderColor, #e5e5e5);
}
.scanner-card__stats .fd-list__item {
  display: flex;
  justify-content: space-between;
  padding: 0.75rem 1rem;
}
.scanner-card__stats .fd-list__secondary {
  font-weight: 700;
  color: var(--sapContent_IconColor, #0a6ed1);
}

/* Footer */
.scanner-footer {
  position: sticky;
  bottom: 0;
  margin-top: auto;
}
.scanner-footer .fd-button {
  min-height: 2.75rem;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
</style>
