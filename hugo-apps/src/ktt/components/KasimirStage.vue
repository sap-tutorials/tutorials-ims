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

      <!-- head group: ears + face features -->
      <g id="head" class="k-head">
        <!-- ears: grey outer + pink inner, splayed outward (behind head crown) -->
        <g id="ears" class="k-ears">
          <path d="M62,54 Q50,30 55,20 Q61,15 70,27 Q81,42 90,52 Z"
                fill="#70747a" stroke="#2b2d34" stroke-width="2.4" stroke-linejoin="round"/>
          <path d="M66,49 Q59,32 62,26 Q67,29 73,37 Q80,45 83,49 Z" fill="#f3aab8"/>
          <!-- ear-tip tuft: little fur point -->
          <path d="M55,20 Q52,13 57,16 M55,20 Q60,12 61,18" fill="none" stroke="#2b2d34"
                stroke-width="1.6" stroke-linecap="round"/>
          <path d="M138,54 Q150,30 145,20 Q139,15 130,27 Q119,42 110,52 Z"
                fill="#70747a" stroke="#2b2d34" stroke-width="2.4" stroke-linejoin="round"/>
          <path d="M134,49 Q141,32 138,26 Q133,29 127,37 Q120,45 117,49 Z" fill="#f3aab8"/>
          <path d="M145,20 Q148,13 143,16 M145,20 Q140,12 139,18" fill="none" stroke="#2b2d34"
                stroke-width="1.6" stroke-linecap="round"/>
        </g>

        <!-- head silhouette: rounded, cheeks wider than crown -->
        <path d="M100,44 C129,44 153,63 153,95 C153,121 139,143 116,151 Q108,154 100,154 Q92,154 84,151 C61,143 47,121 47,95 C47,63 71,44 100,44 Z"
              fill="#70747a" stroke="#2b2d34" stroke-width="2.4" stroke-linejoin="round"/>

        <!-- cowlick tuft: a fun little curl on the crown -->
        <path id="cowlick" class="k-cowlick"
              d="M96,45 Q94,34 100,37 Q97,41 103,42 Q108,40 106,46" fill="none"
              stroke="#2b2d34" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>

        <!-- white blaze: narrow forehead stripe widening into the muzzle -->
        <path d="M88,60 Q100,54 112,60 L119,102 Q129,120 124,136 Q117,153 100,154 Q83,153 76,136 Q71,120 81,102 Z"
              fill="#f6f7f9"/>

        <!-- eyebrows: soft grey brow tufts, a touch of expression -->
        <g id="brows" class="k-brows">
          <path d="M70,84 Q80,80 90,83" fill="none" stroke="#5b5f65" stroke-width="2" stroke-linecap="round"/>
          <path d="M110,83 Q120,80 130,84" fill="none" stroke="#5b5f65" stroke-width="2" stroke-linecap="round"/>
        </g>

        <!-- eyes: smaller, warm, with a friendly upper lid line -->
        <g id="pupils" class="k-pupils">
          <g class="k-eye k-eye-l">
            <ellipse cx="81" cy="101" rx="10.5" ry="11.5" fill="#fff" stroke="#2b2d34" stroke-width="1.8"/>
            <circle cx="81" cy="102" r="7.3" fill="#3a93e0" stroke="#1c6cb4" stroke-width="1.2"/>
            <circle cx="81" cy="103" r="4" fill="#15191f"/>
            <circle cx="84" cy="99" r="2.6" fill="#fff"/>
            <circle cx="78.5" cy="105" r="1.2" fill="#fff" opacity="0.8"/>
          </g>
          <g class="k-eye k-eye-r">
            <ellipse cx="119" cy="101" rx="10.5" ry="11.5" fill="#fff" stroke="#2b2d34" stroke-width="1.8"/>
            <circle cx="119" cy="102" r="7.3" fill="#3a93e0" stroke="#1c6cb4" stroke-width="1.2"/>
            <circle cx="119" cy="103" r="4" fill="#15191f"/>
            <circle cx="122" cy="99" r="2.6" fill="#fff"/>
            <circle cx="116.5" cy="105" r="1.2" fill="#fff" opacity="0.8"/>
          </g>
        </g>

        <!-- upper-lid arcs: static, soften the wide-eyed stare -->
        <g id="lids" class="k-lids">
          <path d="M70.5,98 Q81,92 91.5,98" fill="none" stroke="#2b2d34" stroke-width="1.8" stroke-linecap="round"/>
          <path d="M108.5,98 Q119,92 129.5,98" fill="none" stroke="#2b2d34" stroke-width="1.8" stroke-linecap="round"/>
        </g>

        <!-- eyelids: hidden by default, flashed shut by the blink animation -->
        <g id="eyelids" class="k-eyelids">
          <ellipse cx="81" cy="101" rx="11.5" ry="12.5" fill="#70747a"/>
          <ellipse cx="119" cy="101" rx="11.5" ry="12.5" fill="#70747a"/>
          <!-- closed-eye smile lines -->
          <path d="M71,101 Q81,107 91,101" fill="none" stroke="#2b2d34" stroke-width="1.8" stroke-linecap="round"/>
          <path d="M109,101 Q119,107 129,101" fill="none" stroke="#2b2d34" stroke-width="1.8" stroke-linecap="round"/>
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

      <!-- front paws: white tuxedo mittens (front-most so the facepalm reads) -->
      <g id="pawLeft" class="k-paw-left">
        <ellipse cx="74" cy="230" rx="17" ry="11" fill="#f6f7f9" stroke="#2b2d34" stroke-width="2.4"/>
        <path d="M69,222 L69,238 M79,222 L79,238" fill="none" stroke="#2b2d34" stroke-width="1.4" stroke-linecap="round"/>
      </g>
      <g id="pawRight" class="k-paw-right">
        <ellipse cx="126" cy="230" rx="17" ry="11" fill="#f6f7f9" stroke="#2b2d34" stroke-width="2.4"/>
        <path d="M121,222 L121,238 M131,222 L131,238" fill="none" stroke="#2b2d34" stroke-width="1.4" stroke-linecap="round"/>
      </g>

      <!-- confetti: invisible except during celebrate -->
      <g id="confetti" class="k-confetti">
        <rect x="46" y="48" width="7" height="7" rx="1.5" fill="#0a6ed1"/>
        <rect x="150" y="54" width="7" height="7" rx="1.5" fill="#f0ab00"/>
        <circle cx="70" cy="34" r="3.6" fill="#30914c"/>
        <circle cx="132" cy="30" r="3.6" fill="#ea7088"/>
        <rect x="98" y="22" width="6" height="6" rx="1.5" fill="#e52e5a"/>
        <circle cx="40" cy="72" r="3" fill="#f0ab00"/>
        <circle cx="162" cy="78" r="3" fill="#0a6ed1"/>
      </g>
    </svg>
  </div>
</template>

<style scoped>
/* === Reduced motion: freeze all animations === */
@media (prefers-reduced-motion: reduce) {
  .kasimir * { animation: none !important; }
  .k-confetti { opacity: 0 !important; }
}

/* === Shared base === */
/* Cap the mascot so it never floods its column. Without this the SVG scales
   to full container width and pushes everything below the fold (only his ears
   show). clamp() keeps him proportional across viewports. */
.kasimir {
  width: 100%;
  max-width: clamp(140px, 20vw, 240px);
  margin: 0 auto;
}
.kasimir svg {
  width: 100%;
  height: auto;
  display: block;
}
/* Eyes open by default; the blink animation flashes the lids shut. */
.k-eyelids { opacity: 0; }

/* Blink in EVERY mood so Kasimir always feels alive. Each instance is
   seeded with a slightly different duration to avoid a robotic cadence. */
.kasimir .k-eyelids {
  animation: k-blink 5.4s ease-in-out infinite;
}
.kasimir--teaching .k-eyelids { animation-duration: 4.6s; }
.kasimir--thinking .k-eyelids { animation-duration: 6.2s; }
.kasimir--correct  .k-eyelids { animation-duration: 3.8s; }

@keyframes k-blink {
  0%, 46%, 54%, 100% { opacity: 0; }
  49%, 51%           { opacity: 1; }
}

/* -----------------------------------------------
   IDLE: breathing + tail flick + gentle head sway
----------------------------------------------- */
.kasimir--idle .k-body {
  animation: k-breathe 4s ease-in-out infinite;
  transform-origin: 100px 238px;
}
.kasimir--idle .k-tail {
  animation: k-tail-flick 3.5s ease-in-out infinite;
  transform-origin: 152px 206px;
}
.kasimir--idle .k-head {
  animation: k-head-sway 6.5s ease-in-out infinite;
  transform-origin: 100px 152px;
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
@keyframes k-head-sway {
  0%, 100% { transform: rotate(0deg); }
  30%      { transform: rotate(2.2deg); }
  70%      { transform: rotate(-2.2deg); }
}

/* -----------------------------------------------
   TEACHING: paw gesture (left paw raises) + whisker spread
----------------------------------------------- */
.kasimir--teaching .k-paw-left {
  animation: k-paw-raise 2s ease-in-out infinite;
  transform-origin: 74px 236px;
}
.kasimir--teaching .k-whiskers {
  animation: k-whisker-spread 2s ease-in-out infinite;
}
.kasimir--teaching .k-head {
  animation: k-nod 2s ease-in-out infinite;
  transform-origin: 100px 152px;
}

@keyframes k-paw-raise {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  40%      { transform: translateY(-26px) rotate(-12deg); }
}
@keyframes k-whisker-spread {
  0%, 100% { transform: scaleX(1); }
  50%      { transform: scaleX(1.08); }
}
@keyframes k-nod {
  0%, 100% { transform: rotate(0deg); }
  40%      { transform: rotate(2.5deg); }
}

/* -----------------------------------------------
   THINKING: ear twitch + pupils drift up + head tilt
----------------------------------------------- */
.kasimir--thinking .k-ears {
  animation: k-ear-twitch 2.2s ease-in-out infinite;
  transform-origin: 100px 44px;
}
.kasimir--thinking .k-pupils {
  animation: k-eyes-up 3s ease-in-out infinite;
}
.kasimir--thinking .k-head {
  animation: k-head-tilt 3s ease-in-out infinite;
  transform-origin: 100px 152px;
}

@keyframes k-ear-twitch {
  0%, 100% { transform: rotate(0deg); }
  25%      { transform: rotate(-5deg); }
  75%      { transform: rotate(5deg); }
}
@keyframes k-eyes-up {
  0%, 60%, 100% { transform: translate(0, 0); }
  30%           { transform: translate(2px, -3px); }
}
@keyframes k-head-tilt {
  0%, 100% { transform: rotate(0deg); }
  40%      { transform: rotate(5deg); }
}

/* -----------------------------------------------
   CORRECT: ears perk + eyes sparkle + happy tail wag + bounce
----------------------------------------------- */
.kasimir--correct .k-ears {
  animation: k-ears-perk 0.5s ease-out forwards;
  transform-origin: 100px 44px;
}
.kasimir--correct .k-eye-l {
  animation: k-eye-pop 0.6s ease-in-out 3;
  transform-origin: 81px 101px;
}
.kasimir--correct .k-eye-r {
  animation: k-eye-pop 0.6s ease-in-out 3;
  transform-origin: 119px 101px;
}
.kasimir--correct .k-tail {
  animation: k-tail-wag 0.4s ease-in-out 5;
  transform-origin: 152px 206px;
}
.kasimir--correct .k-head,
.kasimir--correct .k-body {
  animation: k-bounce 0.5s ease-in-out 3;
  transform-origin: 100px 238px;
}

@keyframes k-ears-perk {
  0%   { transform: scaleY(1); }
  100% { transform: scaleY(1.2) translateY(-4px); }
}
@keyframes k-eye-pop {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.08); }
}
@keyframes k-tail-wag {
  0%, 100% { transform: rotate(0deg); }
  25%      { transform: rotate(14deg); }
  75%      { transform: rotate(-14deg); }
}
@keyframes k-bounce {
  0%, 100% { transform: translateY(0); }
  45%      { transform: translateY(-7px); }
}

/* -----------------------------------------------
   WRONG: facepalm (right paw covers eyes) + head droop + flat ears
----------------------------------------------- */
.kasimir--wrong .k-paw-right {
  animation: k-facepalm 1.3s ease-in-out forwards;
  transform-origin: 126px 230px;
}
.kasimir--wrong .k-head {
  animation: k-head-droop 1.3s ease-in-out forwards;
  transform-origin: 100px 152px;
}
.kasimir--wrong .k-ears {
  animation: k-ears-flat 0.5s ease-out forwards;
  transform-origin: 100px 44px;
}

/* Paw rotates about its OWN centre and settles over the eyes/brow. */
@keyframes k-facepalm {
  0%   { transform: translate(0, 0) rotate(0deg); }
  55%  { transform: translate(-22px, -122px) rotate(-15deg); }
  100% { transform: translate(-20px, -118px) rotate(-13deg); }
}
@keyframes k-head-droop {
  0%   { transform: rotate(0deg) translateY(0); }
  55%  { transform: rotate(-5deg) translateY(5px); }
  100% { transform: rotate(-4deg) translateY(4px); }
}
@keyframes k-ears-flat {
  0%   { transform: scaleY(1) rotate(0deg); }
  100% { transform: scaleY(0.68) rotate(6deg); }
}

/* -----------------------------------------------
   CELEBRATE: hop + tail whirl + confetti shimmer on whiskers
----------------------------------------------- */
.kasimir--celebrate .k-head,
.kasimir--celebrate .k-body,
.kasimir--celebrate .k-collar {
  animation: k-hop 0.6s ease-in-out 4;
  transform-origin: 100px 238px;
}
.kasimir--celebrate .k-ears {
  animation: k-ears-perk 0.5s ease-out forwards;
  transform-origin: 100px 44px;
}
.kasimir--celebrate .k-tail {
  animation: k-tail-celebrate 0.4s ease-in-out 8;
  transform-origin: 152px 206px;
}
.kasimir--celebrate .k-whiskers {
  animation: k-whisker-confetti 0.8s ease-in-out 4;
}

/* Confetti burst — hidden everywhere except celebrate */
.k-confetti { opacity: 0; }
.kasimir--celebrate .k-confetti { opacity: 1; }
.kasimir--celebrate .k-confetti > * {
  animation: k-confetti-burst 1.1s ease-in 3;
  transform-box: fill-box;
  transform-origin: center;
}
.kasimir--celebrate .k-confetti > *:nth-child(2) { animation-delay: 0.12s; }
.kasimir--celebrate .k-confetti > *:nth-child(3) { animation-delay: 0.28s; }
.kasimir--celebrate .k-confetti > *:nth-child(4) { animation-delay: 0.06s; }
.kasimir--celebrate .k-confetti > *:nth-child(5) { animation-delay: 0.34s; }
.kasimir--celebrate .k-confetti > *:nth-child(6) { animation-delay: 0.20s; }
.kasimir--celebrate .k-confetti > *:nth-child(7) { animation-delay: 0.42s; }

@keyframes k-hop {
  0%, 100% { transform: translateY(0); }
  40%      { transform: translateY(-14px); }
}
@keyframes k-tail-celebrate {
  0%, 100% { transform: rotate(0deg); }
  50%      { transform: rotate(20deg); }
}
@keyframes k-whisker-confetti {
  0%, 100% { opacity: 0.9; }
  50%      { opacity: 0.4; }
}
@keyframes k-confetti-burst {
  0%   { transform: translateY(8px) scale(0.4) rotate(0deg); opacity: 0; }
  25%  { opacity: 1; }
  100% { transform: translateY(-28px) scale(1) rotate(170deg); opacity: 0; }
}
</style>
