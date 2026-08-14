// hugo-apps/src/ui5/ui5-tutorial.ts — tutorial-page components + modules.
// This is part of the ui5-code-split (#1777) flag-ON path.
// NOTE: TabContainer/Tab are intentionally absent here — they live in ui5-core.ts
// because the codetabs shortcode is also used on non-tutorial pages
// (e.g. hugo/content/u8-codetabs-demo.md). See Ruling 2 in task-2-brief.md.
import "../../../hugo/assets/css/lightbox.css";
import "@ui5/webcomponents/dist/RadioButton.js";
import "@ui5/webcomponents/dist/CheckBox.js";
import "@ui5/webcomponents/dist/RatingIndicator.js";
import "@ui5/webcomponents/dist/ProgressIndicator.js";
import "@ui5/webcomponents/dist/Dialog.js";
import "@ui5/webcomponents/dist/BusyIndicator.js";
import "@ui5/webcomponents/dist/TextArea.js";
import "@ui5/webcomponents/dist/SegmentedButton.js";
import "@ui5/webcomponents/dist/SegmentedButtonItem.js";
import "@ui5/webcomponents-fiori/dist/Wizard.js";
import "@ui5/webcomponents-fiori/dist/SideNavigation.js";
import "@ui5/webcomponents-fiori/dist/SideNavigationItem.js";
import "@ui5/webcomponents-fiori/dist/SideNavigationSubItem.js";
// Lightbox toolbar icons
import "@ui5/webcomponents-icons/dist/zoom-in.js";
import "@ui5/webcomponents-icons/dist/zoom-out.js";
import "@ui5/webcomponents-icons/dist/navigation-left-arrow.js";
import "@ui5/webcomponents-icons/dist/navigation-right-arrow.js";
import "@ui5/webcomponents-icons/dist/reset.js";
import "@ui5/webcomponents-icons/dist/download.js";
// Tutorial local modules
import "../../../hugo/assets/js/codetabs";
import "../../../hugo/assets/js/os-toggle";
import "../../../hugo/assets/js/glossary";
import "../../../hugo/assets/js/reading-progress";
import "../../../hugo/assets/js/lightbox";
import "../../../hugo/assets/js/mission-side-nav";
import "../../../hugo/assets/css/mission-side-nav.css";
