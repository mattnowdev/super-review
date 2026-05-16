---
description: WCAG 2.2 accessibility anti-patterns reference loaded by super-review:run when the diff touches client-facing UI. Covers the new 2.2 criteria (Focus Appearance, Dragging, Target Size, Consistent Help, Redundant Entry, Accessible Authentication) plus the perennial misses — div-as-button, focus management on route/modal change, contrast, label/placeholder confusion, aria-hidden on focusable elements, alt-text discipline. Patterns automated axe/Lighthouse scans miss. Load when `client/`, `app/`, `src/`, `*.tsx`/`*.jsx`/`*.vue`/`*.svelte` files in diff, OR HTML templates touched.
---

# Accessibility (WCAG 2.2) review reference

Anti-patterns the parallel reviewers in [`super-review:run`](../run/SKILL.md) consult when the diff modifies client-facing UI. Automated scanners (axe, Lighthouse, pa11y) catch the obvious cases — missing `alt`, contrast failures on solid backgrounds, empty buttons. What follows is the residue they miss: behavioural failures, the **new WCAG 2.2 success criteria** (published 2023, mandated in the EU under EAA from 2025-06-28), and the patterns AI-generated UI code reliably gets wrong.

## How to use

The orchestrator (`super-review:run`) auto-loads this content into the **Frontend** and **UX** reviewer prompts when it detects client-facing files in the diff (`*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, `*.html`, `*.astro`, files under `client/`, `app/`, `src/components/`, etc.). Each anti-pattern below contributes one prompt-line to the reviewer's checklist.

---

## Anti-pattern: `<div onClick>` without keyboard handler, role, or tabindex
**Detection signal:** A `<div>` or `<span>` with `onClick` / `@click` / `(click)` and no `role`, no `tabIndex`, no `onKeyDown`.
**Verbatim bad code:**
```tsx
<div onClick={() => setOpen(true)} className="btn">Open dialog</div>
```
**Why it's wrong:** Keyboard users (Tab + Enter/Space) cannot reach or activate it; screen readers announce "Open dialog" as plain text, not as an interactive control. Fails WCAG 2.1.1 (Keyboard) and 4.1.2 (Name, Role, Value).
**Fix:** Use `<button type="button">`. If semantic HTML is impossible, add `role="button"`, `tabIndex={0}`, **and** an `onKeyDown` handling both `Enter` and `Space` (Space must `preventDefault` to avoid page scroll).
**Review prompt one-liner:** For every click handler on a non-button non-link element, is there a matching keyboard handler + role + tabindex, or should this be a `<button>`?
**WCAG:** [2.1.1 Keyboard](https://www.w3.org/TR/WCAG22/#keyboard), [4.1.2 Name, Role, Value](https://www.w3.org/TR/WCAG22/#name-role-value)

## Anti-pattern: Focus not returned on modal close / not trapped while open
**Detection signal:** A modal/dialog component that mounts on state change, with no `useEffect` returning focus to the trigger and no focus trap library (`focus-trap-react`, Radix `<Dialog>`, headless-ui) — or a native `<dialog>` opened with `.show()` instead of `.showModal()`.
**Verbatim bad code:**
```tsx
{open && (
  <div className="modal">
    <h2>Confirm</h2>
    <button onClick={() => setOpen(false)}>Close</button>
  </div>
)}
```
**Why it's wrong:** Focus stays on whatever the trigger was; keyboard users Tab into the page behind the modal (it's still in the DOM and focusable). On close, focus jumps to `<body>` and they lose their place. Fails WCAG 2.4.3 (Focus Order) and 2.4.11 (Focus Not Obscured).
**Fix:** Use `<dialog>` with `.showModal()` (browser-native focus trap + Esc handling) OR a vetted headless-UI primitive (Radix `Dialog`, React Aria `Modal`). On open: store `document.activeElement`, move focus to first focusable inside; on close: restore focus to the stored element.
**Review prompt one-liner:** Does every modal/drawer/popover trap focus inside while open AND return focus to the invoking element on close?
**WCAG:** [2.4.3 Focus Order](https://www.w3.org/TR/WCAG22/#focus-order), [2.4.11 Focus Not Obscured](https://www.w3.org/TR/WCAG22/#focus-not-obscured-minimum)

## Anti-pattern: Color contrast below 4.5:1 (body) / 3:1 (large text or UI components)
**Detection signal:** Hex/HSL tokens for grey text on white (e.g. `#999` on `#fff` = 2.85:1), brand colours on coloured backgrounds, placeholder text styled `opacity: 0.5`, "subtle" hint text classes like `text-gray-400` on `bg-white` (Tailwind `gray-400` on `white` = 3.36:1, fails 4.5:1).
**Verbatim bad code:**
```tsx
<p className="text-gray-400">Subscribed — check your inbox.</p>
<input placeholder="Email" className="placeholder:text-gray-300" />
```
**Why it's wrong:** Low-vision users, sunlight glare, and aged displays render the text unreadable. Placeholder text in particular doubles as the only label in many AI-generated forms — failing 1.4.3 and the placeholder-as-label trap below.
**Fix:** Body text ≥ 4.5:1; large text (≥18pt or ≥14pt bold) and non-text UI (icons, input borders, focus rings) ≥ 3:1. Tailwind `gray-600`/`gray-700` for body on white. Verify each token with a contrast checker, not eyeballing.
**Review prompt one-liner:** For every text/background colour pair introduced, is the contrast ratio ≥ 4.5:1 (or ≥ 3:1 for large text and non-text UI components)?
**WCAG:** [1.4.3 Contrast (Minimum)](https://www.w3.org/TR/WCAG22/#contrast-minimum), [1.4.11 Non-text Contrast](https://www.w3.org/TR/WCAG22/#non-text-contrast)

## Anti-pattern: Target size below 24×24 CSS pixels (WCAG 2.2 — 2.5.8)
**Detection signal:** Icon buttons sized `w-4 h-4` / `w-5 h-5` (16-20px), dense table-row action menus, "x" close buttons in toast notifications, social-icon footers with `gap-1`.
**Verbatim bad code:**
```tsx
<button className="w-5 h-5" aria-label="Close"><XIcon /></button>
```
**Why it's wrong:** Motor-impaired users, tremor, touchscreen + thick fingers cannot reliably hit a 20-pixel target without mis-tapping adjacent controls. **WCAG 2.2 introduced 2.5.8 as a minimum**: target must be ≥ 24×24 CSS pixels OR have a 24px-diameter spacing circle around it where no other target intrudes.
**Fix:** Bump to `w-6 h-6` minimum (24px) and pad with `p-2` to reach the 44px Apple HIG / Material Design recommendation. For inline links inside paragraphs the exception applies (inline text is exempt).
**Review prompt one-liner:** Is every interactive target (button, link, icon, checkbox handle) ≥ 24×24 CSS pixels, or does the surrounding spacing leave a 24px exclusion zone?
**WCAG:** [2.5.8 Target Size (Minimum)](https://www.w3.org/TR/WCAG22/#target-size-minimum)

## Anti-pattern: Dragging as the only way to perform an action (WCAG 2.2 — 2.5.7)
**Detection signal:** Kanban boards, image carousels with swipe-only navigation, slider inputs without numeric input fallback, "drag to reorder" lists with no up/down arrow controls, signature pads.
**Verbatim bad code:**
```tsx
<DragDropContext onDragEnd={reorder}>
  {/* no keyboard reorder, no up/down buttons */}
</DragDropContext>
```
**Why it's wrong:** Users with motor impairments, those using head pointers, switch devices, or single-finger touch cannot perform drag gestures. WCAG 2.2 (2.5.7) requires a single-pointer alternative — click, tap, key press — for every drag operation, unless dragging is essential (e.g. drawing apps).
**Fix:** Add up/down arrow buttons next to each draggable row; add "Move to top/bottom" in a kebab menu; for sliders, expose a numeric `<input type="number">` paired with the visual slider. `react-beautiful-dnd`/`dnd-kit` ship keyboard sensors — enable them.
**Review prompt one-liner:** Does every drag interaction have a single-click/tap/keyboard alternative that produces the same result?
**WCAG:** [2.5.7 Dragging Movements](https://www.w3.org/TR/WCAG22/#dragging-movements)

## Anti-pattern: Cognitive-test-style authentication without alternative (WCAG 2.2 — 3.3.8)
**Detection signal:** Sign-in/sign-up flow with image-grid CAPTCHA ("select all traffic lights"), math puzzle ("what is 7 + 3?"), distorted-text CAPTCHA, or memorise-and-retype patterns — without an alternative path.
**Verbatim bad code:**
```tsx
<ReCAPTCHA sitekey={KEY} /> {/* sole verification — no audio, no passkey */}
```
**Why it's wrong:** WCAG 2.2 (3.3.8 Accessible Authentication, Minimum) explicitly bans cognitive function tests as the only authentication step — they exclude users with dyslexia, ADHD, memory disorders, and cognitive disabilities. Failing this is a Level AA conformance failure and a hard legal liability under EAA.
**Fix:** Provide at least one of: passkey/WebAuthn, magic link to email, OAuth (Google/Apple), copy-paste-friendly OTP, or password manager support (no `autocomplete="off"`, no paste blocking). reCAPTCHA v3 (invisible) or hCaptcha "accessibility cookie" are acceptable secondary defences but cannot be the only check.
**Review prompt one-liner:** Does every authentication path offer at least one method that does not require solving a puzzle, recognising images, or transcribing characters?
**WCAG:** [3.3.8 Accessible Authentication (Minimum)](https://www.w3.org/TR/WCAG22/#accessible-authentication-minimum), [3.3.9 Accessible Authentication (Enhanced)](https://www.w3.org/TR/WCAG22/#accessible-authentication-enhanced)

## Anti-pattern: Reset / Clear button adjacent to Submit, destroying form data
**Detection signal:** `<button type="reset">` next to `<button type="submit">`, or a "Clear" button calling `form.reset()` or `setState(initialState)` without a confirmation step.
**Verbatim bad code:**
```tsx
<form onSubmit={save}>
  <input name="essay" />
  <button type="reset">Clear</button>
  <button type="submit">Save</button>
</form>
```
**Why it's wrong:** A misclick (especially on small targets, see 2.5.8) wipes 30 minutes of typing with no undo. Screen-reader users tabbing past Submit hit Reset first. Also implicates 3.3.4 (Error Prevention) for legal/financial/data forms.
**Fix:** Remove Reset buttons by default — they have ~zero legitimate use cases. If a clear-form action is required, make it secondary visual style, require confirmation (`window.confirm` or a modal), and offer undo for 10 seconds via toast.
**Review prompt one-liner:** Is there a `type="reset"` or "Clear" button next to Submit, and if so, can a single click destroy user input without confirmation or undo?
**WCAG:** [3.3.4 Error Prevention (Legal, Financial, Data)](https://www.w3.org/TR/WCAG22/#error-prevention-legal-financial-data)

## Anti-pattern: Heading order skipped (h1 → h3 with no h2)
**Detection signal:** A page or section component starting with `<h1>` and jumping to `<h3>` because "the h2 looked too big" — designer chose size, dev kept semantic name, or component reused at wrong depth.
**Verbatim bad code:**
```tsx
<h1>Account</h1>
<h3>Billing</h3> {/* should be h2 */}
<h4>Payment methods</h4>
```
**Why it's wrong:** Screen-reader users navigate by heading level (NVDA: `H`, `1`-`6` shortcuts); skipped levels break the document outline and they lose the structural map. Fails WCAG 1.3.1 (Info and Relationships).
**Fix:** Heading level reflects nesting depth, not visual size. Use CSS to style (`<h2 className="text-sm">`) — keep semantics correct. Reusable headings should accept an `as` prop or `level` prop, not hard-code `<h2>`.
**Review prompt one-liner:** Within each page, do heading levels descend by 1 with no gaps (h1 → h2 → h3), regardless of visual size?
**WCAG:** [1.3.1 Info and Relationships](https://www.w3.org/TR/WCAG22/#info-and-relationships), [2.4.6 Headings and Labels](https://www.w3.org/TR/WCAG22/#headings-and-labels)

## Anti-pattern: Form input without `<label>` or `aria-labelledby` — placeholder is NOT a label
**Detection signal:** `<input placeholder="Email" />` with no surrounding `<label>`, no `aria-label`, no `aria-labelledby`. Common in "minimalist" sign-up forms and AI-generated card components.
**Verbatim bad code:**
```tsx
<input type="email" placeholder="you@company.com" />
```
**Why it's wrong:** Placeholder disappears on focus; screen readers announce the input as "edit blank" if `aria-label` is missing. Low-contrast placeholder (see 1.4.3) doubles the failure. Auto-fill no longer associates the field correctly. Fails 1.3.1, 3.3.2 (Labels or Instructions), 4.1.2.
**Fix:** Explicit `<label htmlFor="email">Email</label><input id="email" />` OR wrap (`<label>Email <input /></label>`). Use placeholder for *example format only* (`placeholder="name@company.com"`), never as the label. Visually-hidden labels (`sr-only` class) are valid when design forbids visible text.
**Review prompt one-liner:** Does every form input have an associated `<label>`, `aria-label`, or `aria-labelledby`, with the placeholder serving only as a format example?
**WCAG:** [3.3.2 Labels or Instructions](https://www.w3.org/TR/WCAG22/#labels-or-instructions)

## Anti-pattern: Icon-only button without accessible name
**Detection signal:** `<button><Icon /></button>` where `Icon` is an SVG without `<title>`, no `aria-label` on the button, no visually-hidden span.
**Verbatim bad code:**
```tsx
<button onClick={share}><ShareIcon /></button>
```
**Why it's wrong:** Screen readers announce "button" with no name; voice-control users cannot say "click share". Fails 4.1.2 — and axe sometimes misses it when the SVG has aria attributes that look label-ish but aren't.
**Fix:** `<button aria-label="Share this post" onClick={share}><ShareIcon aria-hidden="true" /></button>`. Mark the icon `aria-hidden="true"` so the SVG's own `<title>` or `<text>` doesn't double-announce. If a visible tooltip exists, link it via `aria-describedby`, not as the primary name.
**Review prompt one-liner:** Does every icon-only button have an `aria-label` (or visually-hidden text), with the icon itself marked `aria-hidden="true"`?
**WCAG:** [4.1.2 Name, Role, Value](https://www.w3.org/TR/WCAG22/#name-role-value)

## Anti-pattern: `alt=""` on meaningful images (or descriptive `alt` on decorative ones)
**Detection signal:** Product images, charts, infographics, hero illustrations with `alt=""` because "the linter complained" or because Next.js `<Image>` was used without `alt`. Inverse: decorative dividers and stock illustrations with `alt="image of abstract gradient"`.
**Verbatim bad code:**
```tsx
<Image src="/chart-q3-revenue.png" alt="" /> {/* meaningful, lost to AT */}
<img src="/divider.svg" alt="decorative purple line" /> {/* noise */}
```
**Why it's wrong:** Screen reader announces nothing useful for the chart; announces irrelevant text for the divider. Decision: does the image convey information not already in surrounding text?
**Fix:** Meaningful → `alt="Q3 revenue up 18% to €1.2M"` (describes the **information**, not the file). Decorative → `alt=""` (empty string, present attribute). Functional (icon in link) → describes the destination, not the icon. Complex (chart/diagram) → short `alt` + `aria-describedby` pointing to a longer description or data table below.
**Review prompt one-liner:** For every image, is `alt` text either describing the information conveyed (meaningful) or empty (`alt=""` for decorative) — never describing the file/style?
**WCAG:** [1.1.1 Non-text Content](https://www.w3.org/TR/WCAG22/#non-text-content)

## Anti-pattern: Hidden content via `display: none` still in tab order, OR `aria-hidden="true"` on focusable element
**Detection signal:** Off-screen "mobile menu" toggled via `transform: translateX(-100%)` (still tab-focusable), `visibility: hidden` blocks that fade in but kept reachable; or `aria-hidden="true"` placed on a `<div>` containing buttons/links/inputs.
**Verbatim bad code:**
```tsx
<nav style={{ transform: open ? 'translateX(0)' : 'translateX(-100%)' }}>
  <a href="/x">Hidden link, still tabbable</a>
</nav>

<div aria-hidden="true">
  <button>Submit</button> {/* focusable but hidden from AT — broken state */}
</div>
```
**Why it's wrong:** Keyboard users tab into invisible content and lose focus visibility. `aria-hidden` over focusable descendants creates "ghost focus": sighted keyboard users see the focus ring on nothing; AT users get focus moved to an element the AT cannot announce. Fails 4.1.2, 2.4.3, 2.4.11.
**Fix:** Use `inert` attribute on the off-screen container (browser support: all evergreens since 2023) — removes from tab order AND from AT tree in one go. As fallback, combine `aria-hidden="true"` + `tabindex="-1"` on every focusable child (tedious — `inert` is the right answer).
**Review prompt one-liner:** Is any hidden / off-screen / collapsed content still reachable by Tab, and does any `aria-hidden="true"` container hold focusable descendants?
**WCAG:** [4.1.2 Name, Role, Value](https://www.w3.org/TR/WCAG22/#name-role-value), [2.4.3 Focus Order](https://www.w3.org/TR/WCAG22/#focus-order)

## Anti-pattern: Browser default focus ring removed without replacement (WCAG 2.2 — 2.4.11/2.4.13)
**Detection signal:** Global CSS reset with `*:focus { outline: none }`, `outline: 0`, or Tailwind `focus:outline-none` applied without a corresponding `focus-visible:ring-*`.
**Verbatim bad code:**
```css
*:focus { outline: none; }
```
```tsx
<button className="focus:outline-none">Save</button>
```
**Why it's wrong:** Keyboard users cannot see where focus is. WCAG 2.2 introduced **2.4.11 Focus Not Obscured** and **2.4.13 Focus Appearance** (AAA) — the latter requires the focus indicator to be at least 2 CSS pixels thick, with a 3:1 contrast against unfocused state. Removing the default without replacement is a hard fail.
**Fix:** Always replace, never remove. Use `:focus-visible` (not `:focus`) so the ring shows on keyboard navigation but not on mouse click: `*:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }`. Tailwind: `focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-600`.
**Review prompt one-liner:** Is every interactive element's focus state visible (≥2px, ≥3:1 contrast), and is `:focus-visible` used in preference to `:focus` to suppress the ring on mouse-only interaction?
**WCAG:** [2.4.11 Focus Not Obscured (Minimum)](https://www.w3.org/TR/WCAG22/#focus-not-obscured-minimum), [2.4.13 Focus Appearance](https://www.w3.org/TR/WCAG22/#focus-appearance)

## Anti-pattern: Help link / contact widget in inconsistent location across pages (WCAG 2.2 — 3.2.6)
**Detection signal:** "Contact us" link in header on `/pricing`, in footer on `/dashboard`, missing entirely from `/checkout`; chat widget hidden on legal pages; help link rendered conditionally based on auth state.
**Why it's wrong:** WCAG 2.2 (3.2.6 Consistent Help) requires that if help mechanisms (contact info, chat, FAQ link, automated help) appear on multiple pages, they appear in the **same relative order** across the set. Users with cognitive disabilities rely on muscle-memory location.
**Fix:** Help link lives in the global layout (header or footer), unconditionally rendered. If you want to hide chat on `/checkout` for focus, hide consistently across all checkout-class pages — not at random.
**Review prompt one-liner:** Do help mechanisms (contact, chat, FAQ) appear in the same relative location across every page they appear on?
**WCAG:** [3.2.6 Consistent Help](https://www.w3.org/TR/WCAG22/#consistent-help)

## Anti-pattern: Re-asking for information already provided in the same flow (WCAG 2.2 — 3.3.7)
**Detection signal:** Multi-step checkout asking for email at step 1, then again at step 3 ("for delivery confirmation"); shipping address re-entered as billing address with no "same as shipping" checkbox; re-typing username on a password-reset confirmation screen.
**Why it's wrong:** WCAG 2.2 (3.3.7 Redundant Entry) requires that information previously entered in the same process be auto-populated or available for re-selection, unless re-entry is essential (security re-auth, memory verification with explicit purpose).
**Fix:** Persist form state across steps; pre-fill repeated fields with a clear edit affordance; offer "same as shipping" / "use saved address" controls. State machines (XState, Zustand) make this trivial.
**Review prompt one-liner:** Within any multi-step process, is any field asking for information the user already provided earlier in the same flow, without auto-fill or a copy-from-previous control?
**WCAG:** [3.3.7 Redundant Entry](https://www.w3.org/TR/WCAG22/#redundant-entry)

## What good looks like

### Modal with focus trap + restore
```tsx
import { useEffect, useRef } from 'react';

function Modal({ open, onClose, children }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (open) {
      opener.current = document.activeElement;
      ref.current?.showModal(); // native focus trap + Esc handling
    } else {
      ref.current?.close();
      (opener.current as HTMLElement)?.focus(); // restore
    }
  }, [open]);

  return <dialog ref={ref} onClose={onClose}>{children}</dialog>;
}
```
**Why it works:** `<dialog>.showModal()` is the only browser-native way to get focus-trap + Esc-to-close + inert-background for free. Saved `opener` ref returns focus correctly even when the trigger has unmounted (defensive null-check).
**Affirm:** Every modal/drawer uses `<dialog>.showModal()` or a vetted headless primitive, never bespoke `position: fixed` overlays.

### Keyboard-only focus ring with `:focus-visible`
```css
/* Reset only the default — replace immediately */
:focus { outline: none; }
:focus-visible {
  outline: 2px solid var(--color-focus, currentColor);
  outline-offset: 2px;
  border-radius: 2px;
}
```
**Why it works:** Mouse users don't see the ring (avoids "ugly outline" complaints that lead to removal); keyboard users always do; high-contrast mode picks up `currentColor`.
**Affirm:** Focus styles use `:focus-visible`, not `:focus`, and are never removed without a ≥2px ≥3:1-contrast replacement.

### Skip-to-content as the first focusable element
```tsx
// app/layout.tsx
<body>
  <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:p-3 focus:bg-white focus:ring-2">
    Skip to main content
  </a>
  <Header />
  <main id="main" tabIndex={-1}>{children}</main>
</body>
```
**Why it works:** First Tab press surfaces a visible link that jumps past nav. `tabIndex={-1}` on `<main>` makes it a focus target without making it tab-stop. Crucial on pages with large global headers.
**Affirm:** Every page exposes a skip-to-content link as the first focusable element, surfaced on focus.

### Form input with explicit label + describedby for errors
```tsx
<label htmlFor="email">Email address</label>
<input
  id="email"
  type="email"
  autoComplete="email"
  required
  aria-describedby={error ? 'email-error' : undefined}
  aria-invalid={!!error}
/>
{error && <p id="email-error" role="alert">{error}</p>}
```
**Why it works:** Explicit `htmlFor`/`id` link guarantees the name. `autoComplete="email"` enables password-manager fill (satisfies 3.3.7 across forms). `aria-describedby` + `role="alert"` announces the error to AT on appearance.
**Affirm:** Inputs use explicit `<label htmlFor>`, declare `autoComplete`, and wire errors via `aria-describedby` + `role="alert"`.

### Target size ≥ 44×44 with adequate spacing
```tsx
<button className="min-w-[44px] min-h-[44px] p-3 inline-flex items-center justify-center" aria-label="Close">
  <XIcon className="w-5 h-5" aria-hidden="true" />
</button>
```
**Why it works:** Visual icon stays 20px (design intent); hit target stays 44px (HIG-compliant, exceeds the WCAG 2.2 24px minimum). Spacing classes (`gap-2` minimum) preserve the exclusion zone between adjacent targets.
**Affirm:** Interactive controls reach ≥44×44 hit area via padding even when the visible glyph is smaller; adjacent controls preserve ≥8px spacing.

## Sources
- [WCAG 2.2 Specification (W3C Recommendation, 2023-10-05)](https://www.w3.org/TR/WCAG22/)
- [What's New in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/)
- [MDN — `<dialog>` element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog)
- [MDN — `inert` attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/inert)
- [MDN — `:focus-visible` pseudo-class](https://developer.mozilla.org/en-US/docs/Web/CSS/:focus-visible)
- [European Accessibility Act (EAA) — enforcement from 2025-06-28](https://ec.europa.eu/social/main.jsp?catId=1202)
