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
import "@ui5/webcomponents/dist/RatingIndicator.js";
import "@ui5/webcomponents/dist/ProgressIndicator.js";
import "@ui5/webcomponents/dist/Dialog.js";
import "@ui5/webcomponents/dist/Title.js";
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

import "@ui5/webcomponents-icons/dist/menu2.js";
import "@ui5/webcomponents-icons/dist/share-2.js";
import "@ui5/webcomponents-icons/dist/da.js";
import "@ui5/webcomponents-icons/dist/question-mark.js";
import "@ui5/webcomponents-icons/dist/bell.js";
import "@ui5/webcomponents-icons/dist/person-placeholder.js";
import "@ui5/webcomponents-icons/dist/dark-mode.js";
import "@ui5/webcomponents-icons/dist/light-mode.js";
import "@ui5/webcomponents-icons/dist/course-book.js";
import "@ui5/webcomponents-icons/dist/flight.js";
import "@ui5/webcomponents-icons/dist/sys-monitor.js";
import "@ui5/webcomponents-icons/dist/complete.js";
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

// U8: cross-block selection sync for {{< codetabs >}}.
import "./codetabs";

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
import "../css/mission-side-nav.css";

const root = document.documentElement;

function currentTheme(): "sap_horizon" | "sap_horizon_dark" {
  return root.dataset.theme === "dark" ? "sap_horizon_dark" : "sap_horizon";
}

setTheme(currentTheme());

const observer = new MutationObserver(() => setTheme(currentTheme()));
observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] });
