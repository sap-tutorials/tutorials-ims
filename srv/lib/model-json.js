//
// Reimplements the legacy AEM Sling Model `.model.json` export that
// developers.sap.com served at `/tutorials/<slug>.model.json`.
//
// WHY: SAP Discovery Center (discovery-center.cloud.sap) consumed that export
// to obtain the GitHub source link it uses to load + render tutorial content.
// AEM was decommissioned at the 2026 cutover, so the endpoint now 404s and DC's
// tutorial cards stopped rendering. This module rebuilds the same JSON envelope
// from our own data (Tutorials + RepoCatalog + contributors + tags).
//
// SCOPE (decided 2026-08-12): reproduce the full AEM schema *shape* + every
// metadata field we already hold, and — critically — the GitHub repo link in
// its original location: `contentParsys.buttonBar.feedbackModel.options[]`
// where `linkType === "github"`. DC parses the repo out of that issue-creation
// href. We intentionally do NOT reproduce `tutorialBody.steps[]` rendered HTML:
// DC renders content from GitHub via the link, and we do not persist structured
// per-step HTML server-side (Steps stores only stepOrder + contentHash).
//
// The exact legacy shape this mirrors is captured in the recovered fixture:
//   srv/lib/__tests__/fixtures/legacy-abap-create-project.model.json
// (a 2023 Wayback Machine snapshot — AEM's live endpoint always 403'd crawlers).
//
// Pure module: no `@sap/cds` / DB imports, so the envelope logic is unit-testable
// without a round trip. The DB hydration lives in ./model-json-handler.js.
//

const GITHUB_BASE = 'https://github.com';
const SITE_BASE = 'https://developers.sap.com';
const DEFAULT_OWNER = 'sap-tutorials';
const DEFAULT_BRANCH = 'main';

const PAGE_TYPE = 'developers/components/page/responsive/tutorialPage';
const MODULAR_TYPE = 'developers/components/modular/responsive/tutorialPage';
const RESPONSIVE_GRID_TYPE = 'wcm/foundation/components/responsivegrid';

// SAP logo used as the static og:image (AEM used the same for every tutorial).
const OG_IMAGE = 'http://developers.sap.com/dam/application/shared/logos/sap_logo_rgb_onwhite_0300_0300.png.adapt.png/1656382976488.png';

// --- Static scaffolding reproduced verbatim from the legacy export ----------

// i18n label block — identical for every tutorial page.
const I18N = {
  nextStepsLabel: 'Next Steps', stepsCompletedLabel: 'Steps Completed',
  congratulationsTitle: 'Congratulations!', completeTutorialMessage: 'to complete tutorial',
  tutorialNavigatorLabel: 'Tutorial Navigator', shareLabel: 'Share', checkAnswerLabel: 'Check answer',
  contributorsLabel: 'Contributors', doneLabel: 'Done', technicalErrorMessage: 'Technical Error',
  communityLabel: 'Community', createdByLabel: 'Created by', collapseMessage: 'Collapse content',
  wrongAnswerErrorMessage: 'Sorry, that’s not quite right.', breadcrumbDropdownAltLabel: 'Breadcrumb Dropdown',
  missionLabel: 'Mission', completeStepLabel: 'Complete step', tasksCompletedLabel: 'Tasks Completed',
  logOnLabel: 'Log in', congratulationsTutorialBtnTitle: 'More Tutorials in SAP Tutorial Navigator',
  previousLabel: 'Previous', tutorialsCompletedLabel: 'Tutorials Completed', nextLabel: 'Next',
  congratulationsMissionDescription: 'You’ve completed the mission and earned this badge!',
  congratulationsSgBtnTitle: 'Do next tutorial in the group',
  tutorialsIncludedLabel: 'This tutorial is included in the following', completedLabel: 'Completed',
  congratulationsTypeMission: 'MISSION', backToTopLabel: 'Back to Top', buttonBarAltLabel: 'Button Bar',
  congratulationsMissionBtnTitle: 'Do next tutorial in the mission', closeAllLabel: 'Close all',
  expandMessage: 'Expand content', openAllLabel: 'Open all', feedbackLabel: 'Feedback',
  congratulationsMissionCheckpointBtnTitle: 'Do a checkpoint in the mission', openLabel: 'Open',
  breadcrumbAltLabel: 'Breadcrumb', requireLicenseLabel: 'Requires Customer/Partner License',
  congratulationsGroupDescription: 'You’ve completed the group!', congratulationsSurvey: 'Take our survey',
  groupLabel: 'Group', viewMoreLabel: 'View more',
  communityTooltipLabel: 'This tutorial was created by an SAP Community member',
  shareThisTutorialLabel: 'Share this tutorial', congratulationsTutorialDescription: 'You’ve completed the tutorial!',
  congratulationsShare: 'Share your achievement', mainSectionAltLabel: 'Main section',
  rightAnswerMessage: 'Congratulations! Your answer is correct', tutorialLabel: 'Tutorial',
  expanderAltLabel: 'Toggle accordion',
};

const SHARE_POPUP_MODEL = {
  imageAltText: 'Share popup',
  socialLinks: [
    { completion: true, completionMessage: 'I just completed "$task_name" in SAP Tutorial Navigator:', iconAltText: 'facebook', name: 'facebook', target: '_blank', tooltip: 'Facebook', iconUrl: '/dam/application/shared/images/social-icons/Facebook.png' },
    { completion: true, completionMessage: 'I just completed "$task_name" in SAP Tutorial Navigator:', iconAltText: 'twitter', name: 'twitter', target: '_blank', tooltip: 'twitter', iconUrl: '/dam/application/shared/images/social-icons/Twitter.png' },
    { completion: true, completionMessage: '', iconAltText: 'linkedin', name: 'linkedin', target: '_blank', tooltip: 'LinkedIn', iconUrl: '/dam/application/shared/images/social-icons/Linkedin.png' },
    { completion: false, completionMessage: '', iconAltText: 'Email', name: 'email', target: '_self', tooltip: 'Email share', iconUrl: '/dam/application/shared/images/social-icons/Mail.png' },
  ],
  imagePath: '/dam/application/shared/images/social-icons/282056_PaperAirplane_R_purple 1.png',
};

const FEEDBACK_COMMUNITY_OPTION = {
  circularImage: true, description: 'Get help doing the tutorial',
  href: 'https://answers.sap.com/questions/ask.html?topics=tutorial-navigator',
  hrefTitle: 'Ask the community', imageDirection: 'left2Right', linkType: 'community', target: '_blank',
  image: '/dam/site/developer/pictograms/feedback-icons-01-community.svg/feedback-icons-01-community.svg',
};

const FEEDBACK_SURVEY_OPTION = {
  circularImage: true, description: 'Send us your thoughts',
  href: 'https://sapinsights.eu.qualtrics.com/jfe/form/SV_0im30RgTkbEEHMV?TutorialID=',
  hrefTitle: 'Take our survey', imageDirection: 'left2Right', linkType: 'survey', target: '_blank',
  image: '/dam/site/developer/pictograms/feedback-icons-04-survey.svg/feedback-icons-04-survey.svg',
};

const RESPONSIVE_GRID = {
  ':type': RESPONSIVE_GRID_TYPE,
  allowedComponents: { applicable: false, components: [] },
  columnCount: 12,
  gridClassNames: 'aem-Grid aem-Grid--12 aem-Grid--default--12',
};

// --- Dynamic builders -------------------------------------------------------

// The GitHub feedback option. This is the ONLY place the source repo appears in
// the legacy export, so it is the field DC parses. Encoding mirrors the legacy
// href: title via encodeURIComponent; body with spaces→%20 and newlines→%0A but
// the tutorial URL left literal.
function buildGithubOption({ owner, repo, slug, title }) {
  const body = `Tutorials:%20${SITE_BASE}/tutorials/${slug}.html%0A--------------------------%0A%0AWrite%20here%20how%20you%20think%20we%20can%20improve%20the%20tutorial%20...`;
  const href = `${GITHUB_BASE}/${owner}/${repo}/issues/new?title=${encodeURIComponent(title || '')}&body=${body}`;
  return {
    circularImage: true, description: 'Help improve the tutorial', href,
    hrefTitle: 'Contribute suggestion', imageDirection: 'left2Right', linkType: 'github', target: '_blank',
    image: '/dam/site/developer/pictograms/feedback-icons-02-issue.svg/feedback-icons-02-issue.svg',
  };
}

// tags: [{ label, titlePath }] → { [label]: titlePath } (legacy shape).
function buildTags(tags = []) {
  const out = {};
  for (const t of tags) {
    if (t && t.label) out[t.label] = t.titlePath || '';
  }
  return out;
}

// One contributor → the legacy person shape.
function contributorNode(c) {
  if (!c) return undefined;
  const login = c.login || '';
  return {
    avatarUrl: c.avatarUrl || (login ? `https://avatars.githubusercontent.com/${login}` : ''),
    login,
    name: c.name || login,
    profileUrl: login ? `${GITHUB_BASE}/${login}` : '',
  };
}

// contributors: [{ name, login, avatarUrl, role }] with role in
// {creator, owner, collaborator}. Falls back gracefully when roles are absent.
function buildContributors(contributors = []) {
  const byRole = (r) => contributors.find((c) => (c.role || '').toLowerCase() === r);
  const creator = byRole('creator') || contributors[0];
  const owner = byRole('owner') || creator;
  const assigned = new Set([creator, owner].filter(Boolean));
  const collaborators = contributors.filter((c) => !assigned.has(c));
  const out = {
    collaborators: collaborators.map(contributorNode).filter(Boolean),
    creator: contributorNode(creator),
    owner: contributorNode(owner),
  };
  // Drop undefined person keys so the object stays clean when data is missing.
  if (!out.creator) delete out.creator;
  if (!out.owner) delete out.owner;
  return out;
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildTechnicalFields({ slug, title, description, experienceTag }) {
  const jsonUrl = `${SITE_BASE}/tutorials/${slug}.json`;
  const pageTitle = `${title || ''} | SAP`;
  return {
    metadata: [
      { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: jsonUrl },
      { property: 'og:title', content: pageTitle },
      { property: 'og:description', content: description || '' },
      { property: 'og:site_name', content: 'SAP' },
      { property: 'og:image', content: OG_IMAGE },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:url', content: jsonUrl },
      { name: 'twitter:title', content: pageTitle },
      { name: 'twitter:description', content: description || '' },
      { name: 'twitter:site', content: '@SAP' },
      { name: 'twitter:image', content: OG_IMAGE },
      { name: 'web_site_identifier', content: 'Developer' },
      { name: 'tutorial_experience', content: capitalize(experienceTag) },
      { name: 'language', content: 'English' },
      { name: 'type', content: 'Tutorial' },
    ],
  };
}

// Build the full AEM Sling Model `.model.json` envelope for one tutorial.
//
// Required: slug. Everything else degrades gracefully (missing fields render as
// empty strings / omitted, exactly as the legacy exporter did for sparse pages).
// `repo` should come from RepoCatalog; when absent, the github feedback option
// is omitted (the community + survey options always remain).
function buildModelJson(input = {}) {
  const {
    slug,
    title = '',
    description = '',
    legacyId = null,
    experienceTag = '',
    primaryTagId = '',
    averageTimeToComplete = null,
    tags = [],
    contributors = [],
    owner = DEFAULT_OWNER,
    repo = null,
    // branch retained for signature parity with buildTutorialLinks; the legacy
    // export does not surface the branch, so it is intentionally unused here.
    branch = DEFAULT_BRANCH, // eslint-disable-line no-unused-vars
  } = input;

  if (!slug) throw new Error('buildModelJson: slug is required');

  const feedbackOptions = [FEEDBACK_COMMUNITY_OPTION];
  if (repo) feedbackOptions.push(buildGithubOption({ owner, repo, slug, title }));
  feedbackOptions.push(FEEDBACK_SURVEY_OPTION);

  const contentParsys = {
    ':type': MODULAR_TYPE,
    buttonBar: {
      ':type': MODULAR_TYPE,
      feedbackModel: { headline: 'Feedback?', options: feedbackOptions, imgPath: '/dam/site/developer/photos/feedback-main-2.png' },
      isauthor: 'false',
      iseditmode: 'false',
      outerWrapperClass: 'tutorialPage dx-row1-1 section',
      sharePopupModel: SHARE_POPUP_MODEL,
      wrapperAttributes: {},
    },
    communityPage: false,
    description,
    i18n: I18N,
    imsId: legacyId,
    isPreview: false,
    isauthor: 'false',
    iseditmode: 'false',
    outerWrapperClass: 'tutorialPage dx-row1-2 section',
    prerequisites: { className: 'text-tile prerequisites', text: '', textIsRich: 'true', title: 'Prerequisites' },
    preview: false,
    primaryTagId: primaryTagId || '',
    requiredLicense: false,
    tags: buildTags(tags),
    title,
    // tutorialBody intentionally not populated (see module header). Shape kept
    // so consumers reading `.tutorialBody.steps` get an array, not undefined.
    tutorialBody: { intro: '', steps: [] },
    tutorialDescription: {
      contributors: buildContributors(contributors),
      details: { text: '', textIsRich: 'true', title: 'Details' },
      isContributorsPresent: contributors.length > 0,
      proficiency: { className: 'proficiency', text: capitalize(experienceTag), textIsRich: 'true' },
      time: { className: 'time-to-complete', text: averageTimeToComplete ? `${averageTimeToComplete} min.` : '', textIsRich: 'true' },
      youWillLearn: { className: 'you-will-learn', htmlTitleTag: 'h4', text: '', textIsRich: 'true', title: 'You will learn' },
    },
    wrapperAttributes: {},
  };

  return {
    ':items': {
      parHeader: { ':items': {}, ':itemsOrder': [], ':type': 'foundation/components/iparsys', isauthor: 'false', iseditmode: 'false', outerWrapperClass: '', wrapperAttributes: {} },
      par: {
        ...RESPONSIVE_GRID,
        ':items': {
          par1: {
            ...RESPONSIVE_GRID,
            ':items': { contentParsys },
            ':itemsOrder': ['contentParsys'],
            columnClassNames: { contentParsys: 'aem-GridColumn aem-GridColumn--default--12' },
          },
        },
        ':itemsOrder': ['par1'],
        columnClassNames: { par1: 'aem-GridColumn aem-GridColumn--default--12' },
      },
      technicalFields: buildTechnicalFields({ slug, title, description, experienceTag }),
    },
    ':itemsOrder': ['parHeader', 'par', 'parFooter', 'parBreadCrumb', 'technicalFields'],
    ':path': `/tutorials/${slug}.html`,
    ':type': PAGE_TYPE,
    isAuthor: false,
    isEditMode: false,
    isRtl: false,
    isRtlBp: false,
    isauthor: 'false',
    iseditmode: 'false',
    technicalFields: buildTechnicalFields({ slug, title, description, experienceTag }),
    wrapperAttributes: {},
  };
}

export { buildModelJson, buildGithubOption, buildContributors, buildTags };
