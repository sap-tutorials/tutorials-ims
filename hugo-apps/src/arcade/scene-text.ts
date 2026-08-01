// Verbatim legacy arcade copy — ported from
// sap-community-activity-badges/srv/_i18n/messages.properties (devtoberfest.*).
// Strings are reproduced CHARACTER-FOR-CHARACTER (incl. the U+2019 apostrophe in
// "It's simple") so the arcade scene matches the retired SVG gameboard exactly.

export const RULES_URL =
  'https://community.sap.com/t5/devtoberfest-blog-posts/devtoberfest-2025-contest-official-rules/ba-p/13781577'
export const JOIN_GROUP_URL =
  'https://groups.community.sap.com/t5/devtoberfest/gh-p/Devtoberfest'
export const COMMUNITY_PROFILE_BASE =
  'https://community.sap.com/t5/user/viewprofilepage/user-id/'

// devtoberfest.gameboardHeaderEnd — {0} is the player's first name.
export const gameboardHeader = (firstName: string): string =>
  `${firstName}, Devtoberfest 2025 has started!`

// devtoberfest.scn — the SAP Community profile link label.
export const SCN_LINK_LABEL = 'SAP Community Profile'

// A community-linked player gets a link to their profile; otherwise omit it.
export const communityProfileUrl = (khorosId?: string | null): string | null =>
  khorosId ? `${COMMUNITY_PROFILE_BASE}${khorosId}` : null

// devtoberfest.pointsBanner — {0} score, {1} level. Legacy used the raw numeric
// level; the top level (4) is displayed as its "Nerdvana" label per the design.
export const bannerLevel = (level: number): string =>
  level === 4 ? 'Nerdvana' : String(level)
export const pointsBanner = (score: number, level: number): string =>
  `POINTS: ${score} LEVEL: ${bannerLevel(level)}`

// devtoberfest.level1..level4 — cloud waypoint labels; level 4 is "Nerdvana".
export const levelLabel = (level: number): string =>
  level === 4 ? 'Nerdvana' : level >= 1 ? `Level ${level}` : ''

// --- HOW TO PLAY column (devtoberfest.column1*) ---
export const howToPlay = {
  heading: 'HOW TO PLAY',
  intro: 'It’s simple.  Register for',
  joinLinkLabel: 'Devtoberfest here by clicking Join Group',
  joinLinkUrl: JOIN_GROUP_URL,
  body: 'Complete activities like tutorials or event surveys. Please reference the published list of activities to see where you can earn points:',
  hereLabel: 'here',
  hereUrl: RULES_URL,
}

// --- MAKING THE LAWYERS HAPPY column (devtoberfest.column2*) ---
export const lawyersHappy = {
  heading: 'MAKING THE LAWYERS HAPPY',
  body: 'This gameboard is offered for entertainment purposes only. The actual points calculation for Devtoberfest levels and contest prizes will be done separately and could vary from the points displayed in this gameboard. Final points calculation and prizes are subject to the legal terms and conditions which can be reviewed:',
  hereLabel: 'here',
  hereUrl: RULES_URL,
}

// --- Menu icons (devtoberfest.awards/points/rules/sound) ---
// Awards/Points/Rules all link the contest rules blog (target=_blank); Sound is
// the existing in-scene toggle (rendered by SoundToggle.vue, not this list).
export const menuItems: Array<{ label: string; href: string }> = [
  { label: 'AWARDS', href: RULES_URL },
  { label: 'POINTS', href: RULES_URL },
  { label: 'RULES', href: RULES_URL },
]
