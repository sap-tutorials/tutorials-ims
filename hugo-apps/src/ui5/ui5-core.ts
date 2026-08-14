// hugo-apps/src/ui5/ui5-core.ts — chrome + theme, loaded on every page.
// This is the flag-ON path for the ui5-code-split (#1777).
// hugo/assets/js/ui5-bootstrap.ts is the flag-OFF path — DO NOT modify it.
import { setTheme } from "@ui5/webcomponents-base/dist/config/Theme.js";
import "../../../hugo/assets/css/skeletons.css";
// Theming-only assets (NO blanket Assets.js — that re-adds 11MB CLDR, #1770)
import "@ui5/webcomponents-theming/dist/Assets.js";
import "@ui5/webcomponents/dist/generated/json-imports/Themes.js";
import "@ui5/webcomponents-fiori/dist/generated/json-imports/Themes.js";
// Chrome components
import "@ui5/webcomponents/dist/Avatar.js";
import "@ui5/webcomponents/dist/MessageStrip.js";
import "@ui5/webcomponents/dist/Popover.js";
import "@ui5/webcomponents/dist/Toast.js";
import "@ui5/webcomponents/dist/Button.js";
import "@ui5/webcomponents/dist/Input.js";
import "@ui5/webcomponents/dist/List.js";
import "@ui5/webcomponents/dist/ListItemStandard.js";
import "@ui5/webcomponents/dist/Switch.js";
import "@ui5/webcomponents/dist/Title.js";
import "@ui5/webcomponents-fiori/dist/ShellBar.js";
import "@ui5/webcomponents-fiori/dist/ShellBarItem.js";
import "@ui5/webcomponents-fiori/dist/NotificationListItem.js";
import "@ui5/webcomponents-fiori/dist/illustrations/NoNotifications.js";
// Chrome/nav/verb icons (all icons NOT specific to tutorial lightbox)
import "@ui5/webcomponents-icons/dist/menu2.js";
import "@ui5/webcomponents-icons/dist/share-2.js";
import "@ui5/webcomponents-icons/dist/da.js";
import "@ui5/webcomponents-icons/dist/question-mark.js";
import "@ui5/webcomponents-icons/dist/search.js";
import "@ui5/webcomponents-icons/dist/action-settings.js";
import "@ui5/webcomponents-icons/dist/bbyd-active-sales.js";
import "@ui5/webcomponents-icons/dist/employee.js";
import "@ui5/webcomponents-icons/dist/accept.js";
import "@ui5/webcomponents-icons/dist/home.js";
import "@ui5/webcomponents-icons/dist/palette.js";
import "@ui5/webcomponents-icons/dist/arrow-right.js";
import "@ui5/webcomponents-icons/dist/bell.js";
import "@ui5/webcomponents-icons/dist/person-placeholder.js";
import "@ui5/webcomponents-icons/dist/dark-mode.js";
import "@ui5/webcomponents-icons/dist/light-mode.js";
import "@ui5/webcomponents-icons/dist/course-book.js";
import "@ui5/webcomponents-icons/dist/org-chart.js";
import "@ui5/webcomponents-icons/dist/command-line-interfaces.js";
import "@ui5/webcomponents-icons/dist/flight.js";
import "@ui5/webcomponents-icons/dist/sys-monitor.js";
import "@ui5/webcomponents-icons/dist/complete.js";
import "@ui5/webcomponents-icons/dist/course-program.js";
import "@ui5/webcomponents-icons/dist/settings.js";
import "@ui5/webcomponents-icons/dist/copy.js";
import "@ui5/webcomponents-icons/dist/discussion-2.js";
import "@ui5/webcomponents-icons/dist/write-new-document.js";
import "@ui5/webcomponents-icons/dist/email.js";
import "@ui5/webcomponents-icons/dist/post.js";
import "@ui5/webcomponents-icons/dist/customer-and-contacts.js";
import "@ui5/webcomponents-icons/dist/learning-assistant.js";
import "@ui5/webcomponents-icons/dist/developer-settings.js";
import "@ui5/webcomponents-icons/dist/chain-link.js";
import "@ui5/webcomponents-icons/dist/database.js";
import "@ui5/webcomponents-icons/dist/favorite.js";
import "@ui5/webcomponents-icons/dist/unfavorite.js";
import "@ui5/webcomponents-icons/dist/document.js";
import "@ui5/webcomponents-icons/dist/wrench.js";
import "@ui5/webcomponents-icons/dist/newspaper.js";
import "@ui5/webcomponents-icons/dist/documents.js";
import "@ui5/webcomponents-icons/dist/decline.js";
import "@ui5/webcomponents-icons/dist/navigation-up-arrow.js";   // popover arrows (chrome)
import "@ui5/webcomponents-icons/dist/navigation-down-arrow.js";
// Chrome local modules (imported via relative path — stays in hugo/assets/js for the OFF path)
import "../../../hugo/assets/js/nav-progress";
import "../../../hugo/assets/js/recommend";
import "../../../hugo/assets/js/view-transitions";

const root = document.documentElement;
function currentTheme(): "sap_horizon" | "sap_horizon_dark" {
  return root.dataset.theme === "dark" ? "sap_horizon_dark" : "sap_horizon";
}
setTheme(currentTheme());
queueMicrotask(() => setTheme(currentTheme()));
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTheme(currentTheme()), { once: true });
} else {
  requestAnimationFrame(() => setTheme(currentTheme()));
}
const observer = new MutationObserver(() => setTheme(currentTheme()));
observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] });
