<script setup lang="ts">
defineProps<{ mood: 'idle'|'teaching'|'thinking'|'correct'|'wrong'|'celebrate' }>();
</script>

<template>
  <div class="kasimir" :class="`kasimir--${mood}`" aria-hidden="true">
    <svg viewBox="0 0 200 240" role="img" xmlns="http://www.w3.org/2000/svg">
      <!-- tail behind body -->
      <g id="tail" class="k-tail">
        <path d="M130 190 Q170 210 165 170 Q160 140 140 155 Q135 165 130 190Z"
              fill="#8a8a8a" stroke="#6a6a6a" stroke-width="1"/>
        <!-- white tail tip -->
        <ellipse cx="162" cy="163" rx="8" ry="7" fill="#f0f0f0"/>
      </g>

      <!-- body: grey tuxedo torso -->
      <g id="body" class="k-body">
        <!-- main grey body -->
        <ellipse cx="100" cy="185" rx="48" ry="50" fill="#9a9a9a"/>
        <!-- white chest blaze -->
        <ellipse cx="100" cy="185" rx="22" ry="36" fill="#f0f0f0"/>
      </g>

      <!-- paws -->
      <g id="pawLeft" class="k-paw-left">
        <ellipse cx="68" cy="224" rx="16" ry="10" fill="#9a9a9a"/>
        <!-- white paw tips -->
        <ellipse cx="62" cy="227" rx="5" ry="4" fill="#f0f0f0"/>
        <ellipse cx="70" cy="228" rx="5" ry="4" fill="#f0f0f0"/>
        <ellipse cx="78" cy="226" rx="5" ry="4" fill="#f0f0f0"/>
      </g>
      <g id="pawRight" class="k-paw-right">
        <ellipse cx="132" cy="224" rx="16" ry="10" fill="#9a9a9a"/>
        <!-- white paw tips -->
        <ellipse cx="126" cy="227" rx="5" ry="4" fill="#f0f0f0"/>
        <ellipse cx="134" cy="228" rx="5" ry="4" fill="#f0f0f0"/>
        <ellipse cx="142" cy="226" rx="5" ry="4" fill="#f0f0f0"/>
      </g>

      <!-- collar: dark band + SAP-arrow tag -->
      <g id="collar" class="k-collar">
        <!-- dark collar band -->
        <path d="M64 162 Q100 172 136 162 Q136 172 100 178 Q64 172 64 162Z"
              fill="#2c2c2c"/>
        <!-- blue SAP-arrow tag (shield shape) -->
        <path d="M97 171 L103 171 L103 179 L100 183 L97 179Z" fill="#0070f2"/>
        <!-- small SAP arrow on tag -->
        <path d="M99 174 L101 174 L101 176 L99 176Z" fill="white"/>
      </g>

      <!-- head group: contains ears, face features -->
      <g id="head" class="k-head">
        <!-- grey head circle -->
        <circle cx="100" cy="110" r="52" fill="#9a9a9a"/>

        <!-- white blaze: forehead V marking -->
        <path d="M88 82 Q100 95 112 82 Q100 72 88 82Z" fill="#f0f0f0"/>

        <!-- white muzzle area -->
        <ellipse cx="100" cy="122" rx="22" ry="16" fill="#f0f0f0"/>

        <!-- ears -->
        <g id="ears" class="k-ears">
          <!-- left ear: outer grey + inner pink -->
          <path d="M58 90 L48 55 L78 72Z" fill="#9a9a9a" stroke="#6a6a6a" stroke-width="0.5"/>
          <path d="M62 87 L54 62 L74 75Z" fill="#d48080"/>
          <!-- right ear: outer grey + inner pink -->
          <path d="M142 90 L152 55 L122 72Z" fill="#9a9a9a" stroke="#6a6a6a" stroke-width="0.5"/>
          <path d="M138 87 L146 62 L126 75Z" fill="#d48080"/>
        </g>

        <!-- eyelids for blinking -->
        <g id="eyelids" class="k-eyelids">
          <path d="M76 103 Q85 98 94 103" fill="#9a9a9a" stroke="none"/>
          <path d="M106 103 Q115 98 124 103" fill="#9a9a9a" stroke="none"/>
        </g>

        <!-- big blue eyes with pupils -->
        <g id="pupils" class="k-pupils">
          <!-- left eye: white sclera -->
          <ellipse cx="85" cy="108" rx="12" ry="11" fill="white" stroke="#444" stroke-width="0.8"/>
          <!-- left iris: blue -->
          <ellipse cx="85" cy="108" rx="9" ry="9" fill="#0070f2"/>
          <!-- left pupil: dark vertical slit -->
          <ellipse cx="85" cy="108" rx="3.5" ry="7" fill="#1a1a1a"/>
          <!-- left highlight -->
          <circle cx="89" cy="104" r="2" fill="white" opacity="0.85"/>

          <!-- right eye: white sclera -->
          <ellipse cx="115" cy="108" rx="12" ry="11" fill="white" stroke="#444" stroke-width="0.8"/>
          <!-- right iris: blue -->
          <ellipse cx="115" cy="108" rx="9" ry="9" fill="#0070f2"/>
          <!-- right pupil: dark vertical slit -->
          <ellipse cx="115" cy="108" rx="3.5" ry="7" fill="#1a1a1a"/>
          <!-- right highlight -->
          <circle cx="119" cy="104" r="2" fill="white" opacity="0.85"/>
        </g>

        <!-- pink nose -->
        <path id="nose" class="k-nose"
              d="M97 118 Q100 116 103 118 Q100 122 97 118Z"
              fill="#e87090"/>

        <!-- mouth: gentle curve below muzzle -->
        <g id="mouth" class="k-mouth">
          <path d="M96 122 Q100 126 104 122" fill="none" stroke="#8a5050" stroke-width="1.2" stroke-linecap="round"/>
        </g>

        <!-- whiskers: 3 per side -->
        <g id="whiskers" class="k-whiskers">
          <!-- left whiskers -->
          <line x1="78" y1="120" x2="52" y2="116" stroke="#ccc" stroke-width="0.8" opacity="0.9"/>
          <line x1="78" y1="123" x2="52" y2="123" stroke="#ccc" stroke-width="0.8" opacity="0.9"/>
          <line x1="78" y1="126" x2="54" y2="130" stroke="#ccc" stroke-width="0.8" opacity="0.9"/>
          <!-- right whiskers -->
          <line x1="122" y1="120" x2="148" y2="116" stroke="#ccc" stroke-width="0.8" opacity="0.9"/>
          <line x1="122" y1="123" x2="148" y2="123" stroke="#ccc" stroke-width="0.8" opacity="0.9"/>
          <line x1="122" y1="126" x2="146" y2="130" stroke="#ccc" stroke-width="0.8" opacity="0.9"/>
        </g>
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

/* -----------------------------------------------
   IDLE: gentle breathing + tail flick + blink
----------------------------------------------- */
.kasimir--idle .k-body {
  animation: k-breathe 4s ease-in-out infinite;
  transform-origin: center 200px;
}
.kasimir--idle .k-tail {
  animation: k-tail-flick 3.5s ease-in-out infinite;
  transform-origin: 130px 190px;
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
  transform-origin: 68px 224px;
}
.kasimir--teaching .k-whiskers {
  animation: k-whisker-spread 2s ease-in-out infinite;
}

@keyframes k-paw-raise {
  0%, 100% { transform: translateY(0); }
  40%      { transform: translateY(-22px) rotate(-15deg); }
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
  transform-origin: 100px 72px;
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
   CORRECT: ears perk up + sparkle pulse
----------------------------------------------- */
.kasimir--correct .k-ears {
  animation: k-ears-perk 0.5s ease-out forwards;
  transform-origin: 100px 72px;
}
.kasimir--correct .k-pupils {
  animation: k-eyes-bright 1s ease-in-out 3;
}
.kasimir--correct .k-tail {
  animation: k-tail-wag 0.4s ease-in-out 4;
  transform-origin: 130px 190px;
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
  transform-origin: 132px 224px;
}
.kasimir--wrong .k-ears {
  animation: k-ears-flat 0.4s ease-out forwards;
  transform-origin: 100px 72px;
}

@keyframes k-facepalm {
  0%   { transform: translate(0, 0) rotate(0deg); }
  60%  { transform: translate(-50px, -95px) rotate(-40deg); }
  100% { transform: translate(-48px, -92px) rotate(-38deg); }
}
@keyframes k-ears-flat {
  0%   { transform: scaleY(1) rotate(0deg); }
  100% { transform: scaleY(0.7) rotate(8deg); }
}

/* -----------------------------------------------
   CELEBRATE: hop + confetti colours on whiskers
----------------------------------------------- */
.kasimir--celebrate .k-head,
.kasimir--celebrate .k-body {
  animation: k-hop 0.6s ease-in-out 4;
  transform-origin: center bottom;
}
.kasimir--celebrate .k-tail {
  animation: k-tail-celebrate 0.4s ease-in-out 8;
  transform-origin: 130px 190px;
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
