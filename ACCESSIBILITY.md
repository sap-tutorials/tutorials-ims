# Accessibility

The SAP Tutorial Platform serves [developers.sap.com](https://developers.sap.com), a public-facing site. Accessibility is a requirement, not an enhancement — SAP products target **WCAG 2.1 Level AA** and the EN 301 549 standard. Every UI change must preserve or improve conformance.

## Scope

These standards apply to anything a user sees or interacts with:

- `hugo/` — static tutorial pages, layouts, and page-level JS
- `hugo-apps/` — Vue 3 islands injected into Hugo pages
- `app/` — standalone UI apps (Admin shell/components, Analytics Explorer, Scanner, Display App)
- Rendered tutorial content served from HANA

## Standards we hold to

| Area | Requirement |
| --- | --- |
| **Keyboard** | Every interactive element is reachable and operable by keyboard alone. Logical tab order. No keyboard traps. |
| **Focus** | Visible focus indicator on all focusable elements. Focus is managed on route/dialog/island state changes (move focus to the new context; return it on close). |
| **Semantics** | Use native HTML elements (`button`, `a`, `nav`, `main`, `h1`–`h6`, lists) before ARIA. One `<main>` and a single `<h1>` per page; headings nest without skipping levels. |
| **ARIA** | Only where native semantics fall short. Prefer correct native markup over `role=` patches. Don't put interactive roles on non-interactive elements. |
| **Names & labels** | Every control, input, and icon-only button has an accessible name (visible label, `aria-label`, or `aria-labelledby`). Form fields are programmatically associated with their labels. |
| **Images** | Meaningful images have `alt` text; decorative images use empty `alt=""`. |
| **Color & contrast** | Text meets ≥ 4.5:1 (≥ 3:1 for large text); UI components and focus indicators meet ≥ 3:1. Never use color as the only way to convey information. |
| **Motion** | Respect `prefers-reduced-motion`; avoid content that flashes more than 3×/second. |
| **Zoom / reflow** | Content remains usable at 200% zoom and reflows to a 320 px-wide viewport without loss of function. |
| **Status messages** | Dynamic updates (toasts, async results, validation) are announced via live regions (`aria-live`) without stealing focus. |

## Framework-specific guidance

- **UI5 / Fiori Elements** (Admin UI, Scanner): use standard SAPUI5 controls and their built-in accessibility — don't reimplement controls with raw HTML. Keep the `sap_horizon` theme and its contrast tokens; don't hardcode colors.
- **Vue islands & SPAs** (hugo-apps, Analytics Explorer, Display App): manage focus on mount/route change; label all custom widgets; ensure custom components are keyboard-operable.
- **Hugo pages & tutorial content:** preserve the semantic heading structure the parsers emit; keep landmark regions intact. Served tutorials render `<main>` + `<h1>` (not `<article>`).

## Testing before you ship

Automated checks catch roughly a third of issues — the rest need manual verification.

1. **Keyboard pass:** unplug the mouse. Tab through your change end to end; confirm everything is reachable, operable, and has visible focus.
2. **Screen reader spot-check:** verify names and roles are announced (NVDA/JAWS on Windows, VoiceOver on macOS).
3. **Automated scan:** run an axe-based check (axe DevTools browser extension, or `@axe-core/playwright` in an e2e spec) against the changed page.
4. **Zoom:** test at 200% browser zoom.
5. **Contrast:** verify any new/changed colors against the ratios above.

UI changes to `app/**` or `hugo/**` should carry a committed e2e spec; add accessibility assertions where practical.

## Reporting an accessibility problem

Found an accessibility barrier on the live site? Open a [Site Feedback issue](../../issues/new?template=feedback.yml) and describe the barrier, the page URL, and the assistive technology you were using.

## References

- [Web Content Accessibility Guidelines (WCAG) 2.1](https://www.w3.org/TR/WCAG21/)
- [SAP Accessibility](https://www.sap.com/about/company/sustainability-esg/accessibility.html)
- [SAPUI5 Accessibility guidelines](https://sdk.openui5.org/topic/03b914c5f1be4e24a4a9f6d20dc8d5a3)
