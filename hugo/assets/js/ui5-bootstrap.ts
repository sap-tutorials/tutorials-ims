// UI5 Web Components bootstrap (U0)
// Selective imports keep the bundle tight; the Hugo js.Build pipeline tree-shakes the rest.
// See improvements.md "U0" for scope.
import { setTheme } from "@ui5/webcomponents-base/dist/config/Theme.js";

// U14: shimmer rules for hydration placeholders + nav-progress-bar overrides.
// Selectors are scoped to attributes that only get set on relevant pages.
import "../css/skeletons.css";

// U15: lightbox dialog styles. Scoped to .lightbox-dialog and descendants.
import "../css/lightbox.css";

// Register theme assets for both light and dark — without this side-effect import,
// setTheme("sap_horizon_dark") silently falls back to sap_horizon (only the default is registered).
import "@ui5/webcomponents/dist/Assets.js";
import "@ui5/webcomponents-fiori/dist/Assets.js";

import "@ui5/webcomponents/dist/Avatar.js";
import "@ui5/webcomponents/dist/MessageStrip.js";
import "@ui5/webcomponents/dist/Popover.js";
import "@ui5/webcomponents/dist/Toast.js";
import "@ui5/webcomponents/dist/Button.js";
import "@ui5/webcomponents/dist/Input.js";
import "@ui5/webcomponents/dist/List.js";
import "@ui5/webcomponents/dist/ListItemStandard.js";
import "@ui5/webcomponents/dist/TabContainer.js";
import "@ui5/webcomponents/dist/Tab.js";
import "@ui5/webcomponents/dist/RadioButton.js";
import "@ui5/webcomponents/dist/RatingIndicator.js";
import "@ui5/webcomponents/dist/ProgressIndicator.js";
import "@ui5/webcomponents/dist/Dialog.js";
import "@ui5/webcomponents/dist/BusyIndicator.js";
import "@ui5/webcomponents/dist/TextArea.js";
import "@ui5/webcomponents/dist/Title.js";
// Tutorial preferences popover (header.html) — uses ui5-switch for toggles.
// Without this, the switches render as empty <ui5-switch> with no visible
// control, which is why the popover looked unresponsive. Issue: header
// "Tutorial preferences" with no way to flip anything.
import "@ui5/webcomponents/dist/Switch.js";

// Issue #173: registers <ui5-segmented-button> + <ui5-segmented-button-item>
// for the global OS picker on tutorials with OS-conditional content.
import "@ui5/webcomponents/dist/SegmentedButton.js";
import "@ui5/webcomponents/dist/SegmentedButtonItem.js";
import "@ui5/webcomponents-fiori/dist/ShellBar.js";
import "@ui5/webcomponents-fiori/dist/ShellBarItem.js";
import "@ui5/webcomponents-fiori/dist/Wizard.js";
import "@ui5/webcomponents-fiori/dist/IllustratedMessage.js";
import "@ui5/webcomponents-fiori/dist/SideNavigation.js";
import "@ui5/webcomponents-fiori/dist/SideNavigationItem.js";
import "@ui5/webcomponents-fiori/dist/SideNavigationSubItem.js";

// U7 illustrations — each is a separate side-effect import (default is BeforeSearch).
import "@ui5/webcomponents-fiori/dist/illustrations/PageNotFound.js";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import "@ui5/webcomponents-fiori/dist/illustrations/NoFilterResults.js";
// Themed error pages: 403 uses tnt/Lock, 502 uses UnableToLoad.
import "@ui5/webcomponents-fiori/dist/illustrations/tnt/Lock.js";
import "@ui5/webcomponents-fiori/dist/illustrations/UnableToLoad.js";

import "@ui5/webcomponents-icons/dist/menu2.js";
import "@ui5/webcomponents-icons/dist/share-2.js";
import "@ui5/webcomponents-icons/dist/da.js";
import "@ui5/webcomponents-icons/dist/question-mark.js";
// Shellbar items rendered on every page (search, preferences) — without these,
// UI5 logs "No loader registered for the SAP-icons-v5 icons collection". Issue #104.
import "@ui5/webcomponents-icons/dist/search.js";
import "@ui5/webcomponents-icons/dist/action-settings.js";
// Browse shellbar item (PR #174). Without this, the item renders an empty
// slot in the header — the button container is allocated but the icon glyph
// fails to paint and UI5 logs "Required icon is not registered".
import "@ui5/webcomponents-icons/dist/bbyd-active-sales.js";
// Icons referenced from Vue islands (cmd-palette, MyCompletions, code-check). Imported here so
// they share the main bootstrap's icon registry rather than each island re-registering.
import "@ui5/webcomponents-icons/dist/accept.js";
import "@ui5/webcomponents-icons/dist/home.js";
import "@ui5/webcomponents-icons/dist/palette.js";
import "@ui5/webcomponents-icons/dist/arrow-right.js";
import "@ui5/webcomponents-icons/dist/bell.js";
import "@ui5/webcomponents-icons/dist/person-placeholder.js";
import "@ui5/webcomponents-icons/dist/dark-mode.js";
import "@ui5/webcomponents-icons/dist/light-mode.js";
import "@ui5/webcomponents-icons/dist/course-book.js";
import "@ui5/webcomponents-icons/dist/flight.js";
import "@ui5/webcomponents-icons/dist/sys-monitor.js";
import "@ui5/webcomponents-icons/dist/complete.js";
// Top-nav popover items added in PR #567 (Devtoberfest + Admin UI). Without
// these the browser console logs:
//   "Required icon is not registered. You can either import the icon as a
//    module ... '@ui5/webcomponents-icons/dist/course-program.js'"
// and the two list items render with an empty icon slot. Confirmed live on
// DEV approuter 2026-06-23 via Playwright console capture.
import "@ui5/webcomponents-icons/dist/course-program.js";
import "@ui5/webcomponents-icons/dist/settings.js";
import "@ui5/webcomponents-icons/dist/copy.js";
import "@ui5/webcomponents-icons/dist/discussion-2.js";
import "@ui5/webcomponents-icons/dist/write-new-document.js";
import "@ui5/webcomponents-icons/dist/email.js";
import "@ui5/webcomponents-icons/dist/post.js";
import "@ui5/webcomponents-icons/dist/customer-and-contacts.js";
import "@ui5/webcomponents-icons/dist/favorite.js";
import "@ui5/webcomponents-icons/dist/unfavorite.js";
// U12: reader-mode toggle in shellbar (documents → decline on activation).
import "@ui5/webcomponents-icons/dist/documents.js";
import "@ui5/webcomponents-icons/dist/decline.js";

// U15: lightbox toolbar icons.
import "@ui5/webcomponents-icons/dist/zoom-in.js";
import "@ui5/webcomponents-icons/dist/zoom-out.js";
import "@ui5/webcomponents-icons/dist/navigation-left-arrow.js";
import "@ui5/webcomponents-icons/dist/navigation-right-arrow.js";
import "@ui5/webcomponents-icons/dist/reset.js";
import "@ui5/webcomponents-icons/dist/download.js";

// ui5-popover placement arrows. Even with `hide-arrow`, the component
// still resolves these by name on first render — without them, console
// shows "Required icon is not registered" + "No loader registered for
// the SAP-icons-v5 icons collection". Issue: tutorial-prefs popover.
import "@ui5/webcomponents-icons/dist/navigation-up-arrow.js";
import "@ui5/webcomponents-icons/dist/navigation-down-arrow.js";

// U8: cross-block selection sync for {{< codetabs >}}.
import "./codetabs";

// Issue #173: global OS picker for tutorials with OS-conditional content.
// Self-bootstraps; init() short-circuits when neither [data-os-picker] nor
// [data-os-options] is present, so the cost on non-OS pages is just one
// bundled import.
import "./os-toggle";

// U9: inline glossary tooltips.
import "./glossary";

// U11: reading-progress bar + step scrollspy. Gated on DOM presence —
// safely no-ops on pages without .tutorial-steps / .tutorial-step.
import "./reading-progress";

// U15: image lightbox. Self-bootstraps; safe no-op when #image-lightbox is missing.
import "./lightbox";

// U14: full-page navigation progress bar. Self-bootstraps; safe no-op when
// the #nav-progress element is missing (i.e. partial not rendered).
import "./nav-progress";

// U16: mission side-nav hydration + group expand persistence. Gated on [data-mission-nav].
import "./mission-side-nav";
// Personalized "What's next" rail. Self-bootstraps; safe no-op when [data-recommend-slug] is missing.
import "./recommend";
// View Transitions + scroll-driven animations. Self-bootstraps; safe no-op when APIs missing.
import "./view-transitions";
import "../css/mission-side-nav.css";

const root = document.documentElement;

function currentTheme(): "sap_horizon" | "sap_horizon_dark" {
  return root.dataset.theme === "dark" ? "sap_horizon_dark" : "sap_horizon";
}

// Race fix (issue: dark text on dark background on /me/): the pre-paint script
// in head.html sets html[data-theme=dark] synchronously in <head>, so the
// MutationObserver below never fires for the initial paint. Meanwhile Vue
// islands (e.g. me.js) <script type="module"> tags above this file import UI5
// components like ui5-title / ui5-switch which register themselves BEFORE this
// bootstrap module's top-level evaluates. Those components read the default
// "sap_horizon" (light) theme and render with light --sapTextColor values
// hardcoded in their shadow-DOM CSS — even though the document-level CSS
// variables are correct. Calling setTheme() once at module-eval ALSO loses
// the race because UI5's setTheme is synchronous against the registration
// order at call-time only. The defensive fix: call setTheme on every
// microtask we can think of — at module-eval, after the current event loop
// tick, on DOMContentLoaded, and after first paint. Each call retroactively
// restyles every registered component, so any island that has already booted
// gets correctly themed. Cost is negligible (setTheme is idempotent and only
// triggers a real re-style when the theme actually changes vs cached state).
setTheme(currentTheme());
queueMicrotask(() => setTheme(currentTheme()));
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTheme(currentTheme()), { once: true });
} else {
  requestAnimationFrame(() => setTheme(currentTheme()));
}

const observer = new MutationObserver(() => setTheme(currentTheme()));
observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] });
