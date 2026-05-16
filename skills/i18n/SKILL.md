---
description: Internationalization (i18n) anti-patterns reference loaded by super-review:run. Covers hardcoded strings bypassing i18n, key parity drift across locales, broken pluralization, locale-naive date/number/currency formatting, RTL layout bugs, tests asserting on translated text, missing fallback strategy, concatenated translated fragments, locale-sensitive sorting. Load when the project has any i18n setup (next-intl, react-intl, react-i18next, lingui, @formatjs/*, i18next, vue-i18n, locales/ folder, translation JSONs) and the diff touches client-facing strings or formatting.
---

# i18n review reference

Internationalization anti-patterns for the Frontend / Correctness reviewers in [`super-review:run`](../run/SKILL.md). Auto-loaded when an i18n library is in the dep tree (`next-intl`, `react-intl`, `react-i18next`, `i18next`, `lingui`, `@formatjs/*`, `vue-i18n`) OR a `locales/` / `messages/` / `i18n/` directory exists OR translation JSON/YAML files are in the diff.

**Calibration rule:** if the project ships in > 1 language, i18n bugs become user-visible regressions. CLAUDE.md / REVIEW.md in the project frequently encodes the exact locales required (e.g. Vellam: pl/en/de) — quote and enforce.

---

## Anti-pattern: Hardcoded user-visible string bypassing i18n
**Detection signal:** new JSX with literal English/Polish/whatever text where every neighbouring component uses `t('...')` / `<Trans>` / `useTranslations()`.
**Bad example:**
```tsx
<button>{loading ? 'Wczytywanie...' : 'Zapisz'}</button>
```
**Why it's wrong:** Ships in one locale only; users in other locales see the wrong language mid-UI; QA can't catch it without manual locale-switching.
**Fix:** Use the i18n function: `<button>{t(loading ? 'common.loading' : 'common.save')}</button>`. Add the key to every locale file in this PR.
**Review prompt one-liner:** Any user-visible string literal in JSX/HTML in a project with i18n setup — route through the translation function and add the key to every locale.

## Anti-pattern: Key parity drift across locale files
**Detection signal:** new key added to one locale file (e.g. `pl.json`) but not the others (`en.json`, `de.json`); locale files have different top-level shapes.
**Bad example:**
```diff
// pl.json:
+ "share.modal.bookClubMode": "Tryb klubu książki"
// en.json: not updated
// de.json: not updated
```
**Why it's wrong:** Users in en/de see either the raw key (`share.modal.bookClubMode`), undefined fallback, or the pl text leaking through — depends on the lib's fallback strategy. Either way, broken.
**Fix:** Add the key to every locale file. Most i18n libs ship a parity-check CLI (`i18next-parser`, `formatjs extract` + `compile`); wire it into CI.
**Review prompt one-liner:** For every new translation key, confirm presence + value in every locale file the project declares. Missing key in any locale is a 🟠 FIX-BEFORE-MERGE.

## Anti-pattern: String interpolation breaking pluralization
**Detection signal:** template literal concatenating count + word (`${n} books` or `${n} książki`); ternary `n === 1 ? 'item' : 'items'` (English-only plural assumption).
**Bad example:**
```ts
const msg = `${count} ${count === 1 ? 'książka' : 'książki'}`;
```
**Why it's wrong:** Polish has *three* plural forms (1 / 2-4 / 5+: `1 książka`, `2 książki`, `5 książek`). Russian/Ukrainian have similar rules. Arabic has six forms. English-style ternary breaks everywhere.
**Fix:** Use ICU MessageFormat / your lib's plural API:
```ts
t('books.count', { count }, {
  // ICU: { count, plural, one {książka} few {książki} many {książek} other {książki} }
});
```
**Review prompt one-liner:** Any pluralization that uses a ternary or English-only one/many distinction — replace with ICU MessageFormat plural rules.

## Anti-pattern: Locale-naive date / number / currency formatting
**Detection signal:** `new Date(x).toLocaleString()` without locale arg; `n.toFixed(2)` for currency; `${amount} PLN` hardcoded format; `dayjs(x).format('MM/DD/YYYY')` US-only format used for global users.
**Bad example:**
```tsx
<span>{new Date(order.createdAt).toLocaleString()}</span>
<span>{order.total.toFixed(2)} PLN</span>
```
**Why it's wrong:** `toLocaleString()` without args uses the server's default locale (often `en-US`) — German user sees American date format. Hardcoded "PLN" defeats users with another currency; decimal separator differs (`1,234.56` US vs `1.234,56` DE vs `1 234,56` FR).
**Fix:** `Intl.DateTimeFormat(userLocale).format(d)` and `Intl.NumberFormat(userLocale, { style: 'currency', currency }).format(n)`. Resolve `userLocale` from the request, not the server.
**Review prompt one-liner:** Any date/number/currency formatted client- or server-side — pass the user's locale explicitly to `Intl.*` formatters.

## Anti-pattern: Concatenated translated fragments
**Detection signal:** template literal joining multiple `t(...)` calls (`${t('hello')} ${userName} ${t('welcome')}`); building a sentence from translated parts.
**Bad example:**
```tsx
{t('share.invited')} <b>{userName}</b> {t('share.toBook')} <b>{bookTitle}</b>
```
**Why it's wrong:** Translators get sentence fragments without grammatical context; many languages need different word order (German verb-final), different declensions of `userName`/`bookTitle`, gendered articles depending on the noun. The result reads wrong even when each piece translates correctly.
**Fix:** Single translation key with named placeholders + ICU rich formatting for emphasis:
```ts
t('share.invitedUserToBook', { userName, bookTitle });
// translation: "{userName} został zaproszony do <b>{bookTitle}</b>"
```
**Review prompt one-liner:** Any sentence built by concatenating > 1 translation key — replace with a single key + named placeholders.

## Anti-pattern: Tests asserting on translated user-facing strings
**Detection signal:** `expect(button).toHaveText('Zapisz')` / `getByText('Save')` / `screen.findByText('...')` with a translated label rather than a `data-testid` or stable role.
**Bad example:**
```ts
fireEvent.click(screen.getByText('Zapisz'));
expect(screen.getByText('Pomyślnie zapisano')).toBeVisible();
```
**Why it's wrong:** Test breaks every time copy changes; assumes a specific locale was loaded; failure messages are about the wrong layer (locale config) not the bug.
**Fix:** `getByRole('button', { name: /save|zapisz/i })` if you must, or better: `getByTestId('save-button')` + assert on side effects (mutation called, navigation happened) not on translated text.
**Review prompt one-liner:** Any test asserting on translated UI text — switch to a stable selector (testid / role + i18n key) or assert behavior, not copy.

## Anti-pattern: Missing fallback OR hardcoded fallback in wrong language
**Detection signal:** i18n config without `fallbackLng`; fallback set to a non-default language; `t('key') ?? 'Save'` (English hardcoded fallback in a Polish-first project).
**Bad example:**
```ts
// i18n config
const config = { defaultLocale: 'pl', /* no fallbackLng */ };
// somewhere in code:
const label = t('save') ?? 'Save'; // English fallback in a Polish-first product
```
**Why it's wrong:** Missing key shows the raw key path to users (`common.save`) or a hardcoded English string in a Polish UI — either looks broken / unprofessional.
**Fix:** Configure `fallbackLng: 'pl'` (match the default UI language). Remove inline fallbacks; treat missing keys as a CI failure instead.
**Review prompt one-liner:** Verify `fallbackLng` is set and matches the default UI language; flag any inline `?? 'English string'` fallback.

## Anti-pattern: RTL-naive layout (hardcoded `left`/`right` / `margin-left`)
**Detection signal:** `margin-left`, `padding-right`, `text-align: left`, `border-left`, `left: 0` in CSS for a UI that ships in Arabic/Hebrew/Farsi; `dir="ltr"` hardcoded on `<html>`.
**Bad example:**
```css
.sidebar { padding-left: 1rem; border-left: 1px solid var(--border); }
```
**Why it's wrong:** Sidebar is on the wrong side in RTL locales; padding eats the wrong edge.
**Fix:** Logical properties: `padding-inline-start`, `border-inline-start`, `margin-block-end`, `text-align: start`. Set `dir` per request based on `Accept-Language`.
**Review prompt one-liner:** Any CSS using `left`/`right`/`top`/`bottom` directional properties in a project that may ship RTL — use logical properties (`-inline-start` / `-block-end`).

## Anti-pattern: Locale-sensitive comparison / sorting using default `<`
**Detection signal:** `arr.sort((a, b) => a.name.localeCompare(b.name))` without locale; `arr.sort()` on user-visible strings; `===` on user input vs a stored value.
**Bad example:**
```ts
users.sort((a, b) => a.name.localeCompare(b.name)); // uses runtime default locale
```
**Why it's wrong:** Sort order differs between Polish (`ą` after `a` vs after `z`) and German (`ä` ≈ `a` vs after `z` depending on phonebook vs dictionary collation); `===` on `'café'` vs user input `'café'` (NFD) fails.
**Fix:** `Intl.Collator(userLocale, { sensitivity: 'base' }).compare` for sort; `String.prototype.normalize('NFC')` before any string equality on user-typed text.
**Review prompt one-liner:** Any sort or equality check on user-facing strings — use `Intl.Collator` with explicit locale and normalize first.

## Anti-pattern: Untranslated error messages from server to client
**Detection signal:** Backend throws `Error('Book not found')` and the client renders it raw; HTTP error responses with English `message` shown directly in the UI.
**Bad example:**
```ts
// backend
throw httpErrorWithCode(404, 'book.notFound', 'Book not found');
// client
toast.error(err.message); // shows "Book not found" in Polish UI
```
**Why it's wrong:** Error messages are user-facing too; localizing only happy-path strings creates UX dissonance.
**Fix:** Backend returns the error *code* (`book.notFound`); client looks up the localized message: `toast.error(t(`errors.${err.code}`))`. Add error keys to every locale file alongside UI keys.
**Review prompt one-liner:** Any error message displayed to users from server response — confirm client looks it up via i18n key, not raw `err.message`.

---

## What good looks like

### ICU MessageFormat for plurals + gender
```ts
// translations.json (Polish — three plural forms):
{ "books.count": "{count, plural, one {# książka} few {# książki} many {# książek} other {# książek}}" }
// usage:
t('books.count', { count: 5 }) // "5 książek"
```
**Why:** Survives every language's plural rules. Single key, no concatenation, translator sees the full grammatical context.

### `Intl.*` formatters with explicit user locale
```ts
const fmtCurrency = new Intl.NumberFormat(userLocale, { style: 'currency', currency: order.currency });
const fmtDate = new Intl.DateTimeFormat(userLocale, { dateStyle: 'medium' });
// uses runtime-correct separators, currency symbol position, calendar
```
**Why:** Zero hardcoded format strings; correct for every locale automatically; no library required.

### CI-enforced key parity
```yaml
# .github/workflows/i18n.yml
- run: npx i18next-parser --fail-on-missing-keys --output 'locales/$LOCALE/$NAMESPACE.json'
```
**Why:** Catches drift at PR time, not in production; no human has to remember to add the key to de.json after pl.json.

### Logical CSS properties for RTL
```css
.sidebar {
  padding-inline-start: 1rem;
  border-inline-end: 1px solid var(--border);
  text-align: start;
}
```
**Why:** Same stylesheet works in LTR and RTL; browser handles the flip; no `[dir=rtl]` overrides needed.

### Server returns error codes; client translates
```ts
// backend
throw httpErrorWithCode(404, 'book.notFound', 'Book not found'); // English msg is dev fallback
// client
toast.error(t(`errors.${err.code}`));
```
**Why:** Locale-correct error messages; backend changes don't drag through every UI; new locales added without backend deploy.

---

## Sources
- [Unicode CLDR — Plural rules](https://cldr.unicode.org/index/cldr-spec/plural-rules)
- [ICU MessageFormat syntax](https://unicode-org.github.io/icu/userguide/format_parse/messages/)
- [MDN — `Intl` namespace](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl)
- [MDN — CSS logical properties](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_logical_properties_and_values)
