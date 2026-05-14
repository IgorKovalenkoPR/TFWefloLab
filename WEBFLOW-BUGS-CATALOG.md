# Webflow tablet-bug catalog

This is a **reference** of real-world Webflow tablet bugs that TFWefloLab
knows how to detect. Each entry maps the symptom you see to the detection
code that catches it, so QAs can cross-check their findings against what the
suite already covers.

Source: hand-collected by QA on a real Webflow casino-platform site
(soft2bet.com) at iPad portrait + landscape. Every bug below was reproduced
in production before being encoded as a check.

---

## Bug taxonomy

### 1. Pill / filter button truncates mid-word

**Symptom (what QA sees on the device):**
> A filter chip on the Careers page says `New Jersey, United Sti` —
> "States" gets cut off because the pill is rendered with a fixed width and
> `overflow: hidden` (no `text-overflow: ellipsis`), so the right-hand
> characters are simply chopped.

**Why it happens on Webflow specifically:**
Designer drops a filter component, sets its width manually for a desktop
preview, and forgets that on tablet some option labels are longer than
others (city/state/locale names, role titles in non-English locales).
`overflow: hidden` is the Webflow default for buttons and tags.

**How TFWefloLab catches it:**
- Helper: `findClippedText(page)` — walks every `button` / `.w-button` /
  `.pill` / `.chip` / `.filter` / `.w-dropdown-toggle` and compares
  `scrollWidth` vs `clientWidth` when `overflow:hidden` is in play.
- Spec test: `tests/tablet-bugs.spec.js` — `pill & button text is not
  clipped @tablet-768/820/1024 @<site>`.
- Audit finding type: `text-clipped` · severity Medium · category Layout.

**How to fix in Webflow Designer:**
Open the pill style → set `min-width` instead of fixed `width`, OR set
`text-overflow: ellipsis` so at least the user gets a visual cue.

---

### 2. Icon font fallback character leaks into the UI

**Symptom:**
> Career filter pill renders as `Business Development#` — that trailing `#`
> shouldn't be there; it's a fallback for a custom icon font that didn't
> load (the CSS rule is `content: "\f105"`, but the Webflow icon font
> shipped from a different origin and got blocked / 404'd).

**Why it happens on Webflow:**
Webflow's icon fonts are served from CDN. If the user has an ad-blocker
that blocks third-party fonts, or the CDN is briefly unreachable, the
browser falls back to rendering the Unicode private-use-area glyph as
tofu (`□`), or — when the CSS provides a literal fallback character like
`#` — that character leaks into the visible UI.

**How TFWefloLab catches it:**
- Helper: `findIconFontFallbacks(page)` — walks the DOM for text nodes ≤ 3
  characters containing private-use-area code points (U+E000–U+F8FF) or
  known-fallback singletons (`#`, `?`, `□`, `▢`, `▮`, `▯`, `⏵`, `⏷`,
  `⌃`, `⌄`, `►`, `▼`, `◄`, `▲`).
- Spec test: `no icon-font fallback chars in UI @<vp> @<site>`.
- Audit finding type: `icon-font-fallback` · severity Medium · category
  Images.

**How to fix in Webflow Designer:**
1. Open Project Settings → Custom Code → check that the icon font is
   `@font-face`-declared with a same-origin URL (or with proper CORS).
2. Add a `font-display: swap` fallback to a system glyph that visually
   matches (e.g. `▸` instead of `#`).

---

### 3. Modal / popup occupies <60% of tablet viewport, off-center

**Symptom:**
> The "Book a Meeting" form modal on the news page opens at ~50% of the
> iPad viewport width and is pinned to the right half of the screen.
> Background page is dimmed but the modal feels squeezed — and the email
> input plus soft keyboard occupy the same space.

**Why it happens on Webflow:**
The popup is built as an absolutely-positioned `.popup-wrapper`. The
Designer sets `width: 400px` (because that looked right on desktop) but
doesn't change the breakpoint for tablet, so the popup remains `400px`
inside a 820px tablet viewport — 48% width, off-center.

**How TFWefloLab catches it:**
- Helper: `findMisplacedModals(page)` — looks at every fixed-position or
  high-z-index element matching `[role="dialog"]`, `.modal`, `.popup`,
  `.w-lightbox-container`, etc. Flags if width < 60% of viewport on
  tablet/mobile, or if the modal is off-center by more than 12% of
  viewport width, or extends past viewport edges.
- Spec test: `modals / popups fit and center on tablet @<vp> @<site>` —
  tries to OPEN a likely modal trigger ("Book", "Contact", "Get in touch")
  before measuring, so the test isn't gated on the modal being open in
  initial DOM.
- Audit finding type: (planned — captured by the spec for now).

**How to fix in Webflow Designer:**
Replace fixed `width` with responsive: `width: 92vw; max-width: 560px` on
tablet breakpoint. Center via `margin: auto` + `transform:
translate(-50%, -50%); left: 50%; top: 50%;`.

---

### 4. Header navigation overflows horizontally

**Symptom:**
> On iPad portrait at /products/pam and the Spanish /es/casino... page,
> the header nav items are cramped together. Some items are partially cut
> off at the right edge. The hamburger breakpoint hasn't kicked in yet.

**Why it happens on Webflow:**
The default `.w-nav` breakpoint for switching to a hamburger is `< 992px`.
On 768px–991px tablets the desktop menu still renders, but with longer
locale-specific labels (Spanish "SERVICIOS NOSOTROS NOTICIAS Y EVENTOS")
the total inline width exceeds the container.

**How TFWefloLab catches it:**
- Helper: `findHeaderNavOverflow(page)` — measures `scrollWidth` vs
  `clientWidth` of every `header nav`, `.w-nav-menu`, `[role="banner"]
  nav`, and `.w-nav .w-container`.
- Spec test: `header navigation fits horizontally @<vp> @<site>`.
- Audit finding type: `header-nav-overflow` · severity Medium · category
  Layout.

**How to fix in Webflow Designer:**
Either set the `.w-nav` "Menu button shows at" breakpoint to `< 1024px`
so iPad portrait gets the hamburger, OR shrink the nav-item padding /
font-size at the tablet breakpoint so items fit.

---

### 5. Tap targets smaller than 24×24 px

**Symptom:**
> Small social icons, footer links, and close-buttons (the `×` in
> popups) are <20px square. On iPad mini the user has to be careful where
> they tap — easy to miss.

**Why it happens on Webflow:**
Designers replicate a desktop hover-only target on tablet without resizing.
Common offenders: footer social icons (12–16px), close-X on lightboxes
(18×18), language switchers.

**How TFWefloLab catches it:**
- Helper: `findTinyTapTargets(page)` — flags any interactive element with
  bounding box < 24×24 px.
- Spec test: `tap targets meet WCAG 2.5.5 (24×24) @<vp> @<site>` —
  **soft-fail** (allows up to 10 small targets, annotates the rest).
- Audit finding type: covered by axe-core rule
  `target-size` (Critical / Serious) when run via the Accessibility test
  type.

**How to fix in Webflow Designer:**
Wrap small icons in a padded link container (`padding: 12px`) — the
*tap area* gets the WCAG-passing size even if the visual icon stays
small.

---

## How to run "the soft2bet check" yourself

```bash
# In the dashboard
Run tab → Test types: tick "Tablet bug-hunt" → Browsers/devices: tick
RD iPad Pro 11 / RD iPad Mini → Sites: pick the site → Run.

# CLI alternative
npm run test:tablet-bugs -- --project="RD iPad Pro 11"
```

The run executes **5 checks × 3 tablet viewports = 15 tests per site** at
768, 820 and 1024 wide. Each failed check attaches a full-page screenshot
+ a `page-context.txt` (URL, viewport, project, site) so you can reproduce
on a real device immediately.

---

## What's deliberately **not** in the spec

Some bugs spotted in the soft2bet archive are domain-specific and not
worth encoding as universal Webflow rules:

- **Soft keyboard covers half of an open modal** (bug-06) — this is a
  device/OS behaviour, not a site bug. Modern Webflow forms use
  `viewport-fit=cover` so the modal moves up when the keyboard opens;
  testing this requires a real iPad with a software keyboard, which is
  outside what Playwright can emulate.
- **The Webflow editor "edit" button on the right edge** (bug-07/08) —
  only visible when an editor is logged in. Won't appear on production.
- **Image LCP / above-the-fold heaviness** — covered separately by the
  Performance (Lighthouse) test type, not the tablet-bugs spec.
