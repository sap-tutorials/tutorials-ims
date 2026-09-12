<script setup lang="ts">
defineProps<{ mood: 'idle'|'teaching'|'thinking'|'correct'|'wrong'|'celebrate' }>();
</script>

<template>
  <div class="kasimir" :class="`kasimir--${mood}`" aria-hidden="true">
    <svg viewBox="0 0 200 240" role="img" xmlns="http://www.w3.org/2000/svg">
      <!-- tail behind body: fluffy grey with white tip -->
      <g id="tail" class="k-tail">
        <path d="M150,206 C184,206 192,172 180,150 C174,138 159,139 156,154 C161,171 172,192 150,206 Z"
              fill="#64686e" stroke="#2b2d34" stroke-width="2.4" stroke-linejoin="round"/>
        <path d="M180,150 C186,140 176,131 168,137 C162,141 163,150 168,154 C172,150 177,149 180,150 Z"
              fill="#f6f7f9" stroke="#2b2d34" stroke-width="2.4" stroke-linejoin="round"/>
      </g>

      <!-- body: grey tuxedo torso + white chest bib -->
      <g id="body" class="k-body">
        <path d="M100,150 C56,150 42,184 42,208 C42,228 62,238 100,238 C138,238 158,228 158,208 C158,184 144,150 100,150 Z"
              fill="#70747a" stroke="#2b2d34" stroke-width="2.4" stroke-linejoin="round"/>
        <path d="M100,153 C84,158 80,186 81,206 C82,224 100,230 100,230 C100,230 118,224 119,206 C120,186 116,158 100,153 Z"
              fill="#f6f7f9"/>
      </g>

      <!-- front paws: white tuxedo mittens -->
      <g id="pawLeft" class="k-paw-left">
        <ellipse cx="74" cy="230" rx="17" ry="11" fill="#f6f7f9" stroke="#2b2d34" stroke-width="2.4"/>
        <path d="M69,222 L69,238 M79,222 L79,238" fill="none" stroke="#2b2d34" stroke-width="1.4" stroke-linecap="round"/>
      </g>
      <g id="pawRight" class="k-paw-right">
        <ellipse cx="126" cy="230" rx="17" ry="11" fill="#f6f7f9" stroke="#2b2d34" stroke-width="2.4"/>
        <path d="M121,222 L121,238 M131,222 L131,238" fill="none" stroke="#2b2d34" stroke-width="1.4" stroke-linecap="round"/>
      </g>

      <!-- head group: ears + face features -->
      <g id="head" class="k-head">
        <!-- ears: grey outer + pink inner, splayed outward (behind head crown) -->
        <g id="ears" class="k-ears">
          <path d="M62,54 Q50,30 55,20 Q61,15 70,27 Q81,42 90,52 Z"
                fill="#70747a" stroke="#2b2d34" stroke-width="2.4" stroke-linejoin="round"/>
          <path d="M66,49 Q59,32 62,26 Q67,29 73,37 Q80,45 83,49 Z" fill="#f3aab8"/>
          <path d="M138,54 Q150,30 145,20 Q139,15 130,27 Q119,42 110,52 Z"
                fill="#70747a" stroke="#2b2d34" stroke-width="2.4" stroke-linejoin="round"/>
          <path d="M134,49 Q141,32 138,26 Q133,29 127,37 Q120,45 117,49 Z" fill="#f3aab8"/>
        </g>

        <!-- head silhouette: rounded, cheeks wider than crown -->
        <path d="M100,44 C129,44 153,63 153,95 C153,121 139,143 116,151 Q108,154 100,154 Q92,154 84,151 C61,143 47,121 47,95 C47,63 71,44 100,44 Z"
              fill="#70747a" stroke="#2b2d34" stroke-width="2.4" stroke-linejoin="round"/>

        <!-- white blaze: narrow forehead stripe widening into the muzzle -->
        <path d="M88,60 Q100,54 112,60 L119,102 Q129,120 124,136 Q117,153 100,154 Q83,153 76,136 Q71,120 81,102 Z"
              fill="#f6f7f9"/>

        <!-- eyelids: hidden by default, flashed by the blink animation -->
        <g id="eyelids" class="k-eyelids">
          <ellipse cx="80" cy="98" rx="15.5" ry="16.5" fill="#70747a"/>
          <ellipse cx="120" cy="98" rx="15.5" ry="16.5" fill="#70747a"/>
        </g>

        <!-- big round blue eyes -->
        <g id="pupils" class="k-pupils">
          <ellipse cx="80" cy="98" rx="15" ry="16" fill="#fff" stroke="#2b2d34" stroke-width="2"/>
          <circle cx="80" cy="100" r="10.5" fill="#2f8ede" stroke="#1c6cb4" stroke-width="1.4"/>
          <circle cx="80" cy="101" r="6" fill="#15191f"/>
          <circle cx="84.5" cy="95.5" r="3.2" fill="#fff"/>
          <circle cx="77" cy="104" r="1.6" fill="#fff" opacity="0.85"/>
          <ellipse cx="120" cy="98" rx="15" ry="16" fill="#fff" stroke="#2b2d34" stroke-width="2"/>
          <circle cx="120" cy="100" r="10.5" fill="#2f8ede" stroke="#1c6cb4" stroke-width="1.4"/>
          <circle cx="120" cy="101" r="6" fill="#15191f"/>
          <circle cx="124.5" cy="95.5" r="3.2" fill="#fff"/>
          <circle cx="117" cy="104" r="1.6" fill="#fff" opacity="0.85"/>
        </g>

        <!-- pink nose -->
        <path id="nose" class="k-nose"
              d="M92,116 Q100,113 108,116 Q104,127 100,129 Q96,127 92,116 Z"
              fill="#ea7088" stroke="#b05266" stroke-width="1"/>

        <!-- mouth: philtrum + soft smile -->
        <g id="mouth" class="k-mouth">
          <path d="M100,129 L100,137" fill="none" stroke="#2b2d34" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M84,137 Q100,150 116,137" fill="none" stroke="#2b2d34" stroke-width="2" stroke-linecap="round"/>
        </g>

        <!-- whiskers: 3 per side -->
        <g id="whiskers" class="k-whiskers">
          <path d="M78,124 Q64,120 50,119" fill="none" stroke="#b9bcc1" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M78,128 Q63,128 49,131" fill="none" stroke="#b9bcc1" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M78,132 Q64,137 52,143" fill="none" stroke="#b9bcc1" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M122,124 Q136,120 150,119" fill="none" stroke="#b9bcc1" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M122,128 Q137,128 151,131" fill="none" stroke="#b9bcc1" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M122,132 Q136,137 148,143" fill="none" stroke="#b9bcc1" stroke-width="1.4" stroke-linecap="round"/>
        </g>
      </g>

      <!-- collar: dark band + SAP tag (drawn after head so it sits in front) -->
      <g id="collar" class="k-collar">
        <path d="M62,158 Q100,176 138,158 Q138,170 100,183 Q62,170 62,158 Z"
              fill="#23262b" stroke="#14161a" stroke-width="1"/>
        <circle cx="100" cy="177" r="3" fill="#c8ccd0" stroke="#14161a" stroke-width="0.8"/>
        <rect x="88" y="181" width="24" height="15" rx="3" fill="#0a6ed1" stroke="#0a4e97" stroke-width="1"/>
        <text x="100" y="192" text-anchor="middle" font-family="Arial,Helvetica,sans-serif"
              font-size="8" font-weight="700" fill="#fff">SAP</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
/* === Reduced motion: freeze all animations === */
@media (prefers-reduced-motion: reduce) {
  .kasimir * { animation: none !important; }
}

/* === Shared base === */
.kasimir svg {
  width: 100%;
  height: auto;
  display: block;
}
/* Eyes open by default; the blink animation flashes the lids shut. */
.k-eyelids { opacity: 0; }

/* -----------------------------------------------
   IDLE: gentle breathing + tail flick + blink
----------------------------------------------- */
.kasimir--idle .k-body {
  animation: k-breathe 4s ease-in-out infinite;
  transform-origin: 100px 238px;
}
.kasimir--idle .k-tail {
  animation: k-tail-flick 3.5s ease-in-out infinite;
  transform-origin: 152px 206px;
}
.kasimir--idle .k-eyelids {
  animation: k-blink 5s ease-in-out infinite;
}

@keyframes k-breathe {
  0%, 100% { transform: scaleY(1); }
  50%       { transform: scaleY(1.03); }
}
@keyframes k-tail-flick {
  0%, 100% { transform: rotate(0deg); }
  30%      { transform: rotate(8deg); }
  60%      { transform: rotate(-4deg); }
}
@keyframes k-blink {
  0%, 90%, 100% { opacity: 0; }
  92%, 96%      { opacity: 1; }
}

/* -----------------------------------------------
   TEACHING: paw gesture (left paw raises)
----------------------------------------------- */
.kasimir--teaching .k-paw-left {
  animation: k-paw-raise 2s ease-in-out infinite;
  transform-origin: 74px 236px;
}
.kasimir--teaching .k-whiskers {
  animation: k-whisker-spread 2s ease-in-out infinite;
}

@keyframes k-paw-raise {
  0%, 100% { transform: translateY(0); }
  40%      { transform: translateY(-24px) rotate(-12deg); }
}
@keyframes k-whisker-spread {
  0%, 100% { transform: scaleX(1); }
  50%      { transform: scaleX(1.08); }
}

/* -----------------------------------------------
   THINKING: ear twitch + pupils drift up
----------------------------------------------- */
.kasimir--thinking .k-ears {
  animation: k-ear-twitch 2.2s ease-in-out infinite;
  transform-origin: 100px 44px;
}
.kasimir--thinking .k-pupils {
  animation: k-eyes-up 3s ease-in-out infinite;
}

@keyframes k-ear-twitch {
  0%, 100% { transform: rotate(0deg); }
  25%      { transform: rotate(-5deg); }
  75%      { transform: rotate(5deg); }
}
@keyframes k-eyes-up {
  0%, 60%, 100% { transform: translateY(0); }
  30%           { transform: translateY(-3px); }
}

/* -----------------------------------------------
   CORRECT: ears perk up + eyes brighten + tail wag
----------------------------------------------- */
.kasimir--correct .k-ears {
  animation: k-ears-perk 0.5s ease-out forwards;
  transform-origin: 100px 44px;
}
.kasimir--correct .k-pupils {
  animation: k-eyes-bright 1s ease-in-out 3;
}
.kasimir--correct .k-tail {
  animation: k-tail-wag 0.4s ease-in-out 4;
  transform-origin: 152px 206px;
}

@keyframes k-ears-perk {
  0%   { transform: scaleY(1); }
  100% { transform: scaleY(1.2) translateY(-4px); }
}
@keyframes k-eyes-bright {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.08); }
}
@keyframes k-tail-wag {
  0%, 100% { transform: rotate(0deg); }
  25%      { transform: rotate(14deg); }
  75%      { transform: rotate(-14deg); }
}

/* -----------------------------------------------
   WRONG: facepalm (right paw up to face) + flat ears
----------------------------------------------- */
.kasimir--wrong .k-paw-right {
  animation: k-facepalm 1.2s ease-in-out forwards;
  transform-origin: 126px 236px;
}
.kasimir--wrong .k-ears {
  animation: k-ears-flat 0.4s ease-out forwards;
  transform-origin: 100px 44px;
}

@keyframes k-facepalm {
  0%   { transform: translate(0, 0) rotate(0deg); }
  60%  { transform: translate(-26px, -108px) rotate(-38deg); }
  100% { transform: translate(-24px, -104px) rotate(-36deg); }
}
@keyframes k-ears-flat {
  0%   { transform: scaleY(1) rotate(0deg); }
  100% { transform: scaleY(0.7) rotate(8deg); }
}

/* -----------------------------------------------
   CELEBRATE: hop + confetti shimmer on whiskers
----------------------------------------------- */
.kasimir--celebrate .k-head,
.kasimir--celebrate .k-body,
.kasimir--celebrate .k-collar {
  animation: k-hop 0.6s ease-in-out 4;
  transform-origin: 100px 238px;
}
.kasimir--celebrate .k-tail {
  animation: k-tail-celebrate 0.4s ease-in-out 8;
  transform-origin: 152px 206px;
}
.kasimir--celebrate .k-whiskers {
  animation: k-whisker-confetti 0.8s ease-in-out 4;
}

@keyframes k-hop {
  0%, 100% { transform: translateY(0); }
  40%      { transform: translateY(-12px); }
}
@keyframes k-tail-celebrate {
  0%, 100% { transform: rotate(0deg); }
  50%      { transform: rotate(20deg); }
}
@keyframes k-whisker-confetti {
  0%, 100% { opacity: 0.9; }
  50%      { opacity: 0.4; }
}
</style>
