// UI5 Web Components bootstrap (U0)
// Selective imports keep the bundle tight; the Hugo js.Build pipeline tree-shakes the rest.
// See improvements.md "U0" for scope.
import { setTheme } from "@ui5/webcomponents-base/dist/config/Theme.js";

// Register theme assets for both light and dark — without this side-effect import,
// setTheme("sap_horizon_dark") silently falls back to sap_horizon (only the default is registered).
import "@ui5/webcomponents/dist/Assets.js";
import "@ui5/webcomponents-fiori/dist/Assets.js";

import "@ui5/webcomponents/dist/Avatar.js";
import "@ui5/webcomponents/dist/MessageStrip.js";
import "@ui5/webcomponents/dist/Popover.js";
import "@ui5/webcomponents/dist/Button.js";
import "@ui5/webcomponents/dist/Input.js";
import "@ui5/webcomponents/dist/List.js";
import "@ui5/webcomponents/dist/ListItemStandard.js";
import "@ui5/webcomponents/dist/TabContainer.js";
import "@ui5/webcomponents/dist/Tab.js";
import "@ui5/webcomponents-fiori/dist/ShellBar.js";
import "@ui5/webcomponents-fiori/dist/ShellBarItem.js";

import "@ui5/webcomponents-icons/dist/menu2.js";
import "@ui5/webcomponents-icons/dist/share-2.js";
import "@ui5/webcomponents-icons/dist/da.js";
import "@ui5/webcomponents-icons/dist/question-mark.js";
import "@ui5/webcomponents-icons/dist/bell.js";
import "@ui5/webcomponents-icons/dist/building.js";
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

const root = document.documentElement;

function currentTheme(): "sap_horizon" | "sap_horizon_dark" {
  return root.dataset.theme === "dark" ? "sap_horizon_dark" : "sap_horizon";
}

setTheme(currentTheme());

const observer = new MutationObserver(() => setTheme(currentTheme()));
observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] });
