# Design System — offline-consent

> This file is law. It documents a system that already existed in code and had no
> written form, which is how it started to drift. Where a rule below contradicts
> what a file currently does, the file is wrong.

**The one thing to remember after using this product: _this will hold up._**
It should feel like evidence that survives a Board proceeding. Every rule here
serves that. When a decision is genuinely balanced, pick the option that would be
easier to defend to a regulator.

## Product Context

- **What this is:** A register for consent collected on paper, under India's DPDP
  Act 2023. Signed forms are digitised into durable evidence, and the person who
  signed can find their record and withdraw per purpose.
- **Who it's for:** Two audiences that share nothing.
  - **Data Principal** — the person who signed. Public portal, no account, no
    password, one-time code. Mostly a phone, in India. s.6(4) requires withdrawal
    to be as easy as giving consent, so friction here is a compliance failure.
  - **Staff** — an **Operator** transcribing scans at volume with the scan beside
    the fields, and a **DPO** working register search, audit trails and three
    compliance queues.
- **Space:** Privacy and compliance tooling. The category norm is a marketing-site
  aesthetic (Vanta leads with purple, a logo wall and "Trust is everything"). This
  product deliberately does not look like that. The category's visual language is
  built to *sell* trust; this one has to *survive being examined*.
- **Project type:** Internal tool (console) plus a small public flow (portal).

## Aesthetic Direction

- **Direction:** Industrial / Utilitarian. Function first, data dense, muted.
- **Decoration level:** Minimal. Typography and rules do the work. No texture, no
  gradient, no ornament, no illustration.
- **Mood:** A document, not a dashboard. Calm, precise, slightly austere. The
  console should feel one step ahead of the DPO. The portal should feel like
  nothing at all until it is over, and then like proof.
- **Reference points:** Linear for type-scale discipline (not its dark theme).
  Vanta as a **negative** reference: purple, logo wall, hero claim.

## Typography

- **Display / Hero:** Inter, 600. Kept deliberately. See _Considered and declined_.
- **Body / UI / Labels:** Inter.
- **Data / Tables:** Inter with `font-variant-numeric: tabular-nums` (the
  `.tabular` class). Mandatory for anything that must line up in a column: phone
  numbers, dates, hashes, counts.
- **Code:** `ui-monospace, SFMono-Regular, Menlo, monospace`.
- **Loading:** `next/font/google`, `Inter`, `subsets: ["latin"]`, exposed as
  `--font-inter`. Self-hosted by Next at build time; no runtime CDN request.

### Scale

Five steps. There is no sixth: a hash at 11px is a legibility bug, not a detail.

| Level | Size / line-height | Weight | Tracking | Use |
|---|---|---|---|---|
| `h1` | 28 / 32 | 600 | -0.02em | One per page, names the page |
| `h2` | 20 / 26 | 600 | -0.01em | A section within a page |
| `h3` | 16 / 22 | 600 | — | A card, a record, a row subject |
| body | 14 / 20 | 400 | — | Everything else |
| label | 12 / 16 | 550 | — | Field labels, metadata |
| column head | 12 / 16 | 550 | +0.06em, uppercase | Table headers only |

**Migration is a promotion, not a rewrite.** Today's `h1` (20px) becomes `h2`.
Today's `h2` (14px) becomes body. As of this file: 25 `h1` usages, 2 `h2`, 0 `h3`,
and `h2` was byte-identical to body.

**The portal runs one step up:** body 16px, `h1` 24px on a phone and 28px on
desktop. This is not taste. Safari auto-zooms any input under 16px, and an
unexpected zoom mid-OTP is exactly the friction s.6(4) prohibits. Touch targets
stay at 44px minimum.

## Color

- **Approach:** Restrained. One light palette. Colour is rare and semantic: it
  appears when a consent state changes or an obligation falls due, never for
  decoration.
- **No dark mode.** A second theme is surface area no reader asked for. This is
  read by operators under office lighting and by members on their phones.

| Token | Hex | Meaning |
|---|---|---|
| `--ink` | `#14181f` | Primary text |
| `--muted` | `#5b6472` | Secondary text (AA at 5.58:1) |
| `--line` | `#dfe3e9` | Borders, rules |
| `--panel` | `#ffffff` | Raised surface |
| `--canvas` | `#f7f6f3` | Page ground |
| `--navy` | `#16233c` | Primary action |
| `--blue` | `#1f57c3` | Links, focus (AA at 6.10:1) |
| `--green` | `#176b3f` | Live consent, completion |
| `--red` | `#b3261e` | Withdrawn, error, overdue |
| `--amber` | `#8a5a00` | Owed, held, waiting |

Each hue has a `-soft` tint for callout and badge grounds: `--blue-soft #eaf0fc`,
`--green-soft #e7f4ec`, `--red-soft #fbeceb`, `--amber-soft #fdf2dc`.

**`--canvas` is warm on purpose (`#f7f6f3`, was `#f6f7f9`).** Cool grey is the SaaS
tell. A faintly warm ground makes `--panel #ffffff` read as a sheet on a desk
rather than a card floating in a dashboard. `--ink` and `--line` stay neutral:
warm the ground, not the type.

**Never encode meaning in colour alone.** Every state carries a word as well as a
hue. `role="alert"` is decided by whether the message answers something the person
just did, never by whether the message is red.

## Spacing

- **Base unit:** 4px.
- **Density:** Compact in the console, comfortable in the portal.
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64).

**One Panel, two paddings.** `16px` dense (tables, queues, the console) and `24px`
calm (the portal, a single record). Four paddings is not a system. As of this file
there are 12 hand-rolled panel shells across 5 paddings (`p-4` ×7, `px-5 py-4` ×2,
`p-6`, `p-5`, `px-3 py-2`); all of them should be the `Panel` primitive.

## Layout

- **Approach:** Grid-disciplined. Predictable alignment; no asymmetry, no
  grid-breaking.
- **Max content width:** 1152px (`max-w-6xl`).
- **Border radius:** 6px, flat. No hierarchical radius scale, no pill shapes except
  `Badge`.
- **The staff nav owns its own row.** Sharing a row with the wordmark, the role
  label and Sign out left the links 714px for 890px of content, so a compliance
  queue sat off-screen behind a scroller with no affordance. A horizontal scroller
  is not a way to reach a link.
- **Below 1024px, the scan must stay with the fields.** An operator transcribing
  paper with the scan off-screen is transcribing from memory.

## Motion

- **Approach:** Minimal-functional. Only transitions that aid comprehension.
- **Easing:** enter `ease-out`, exit `ease-in`, move `ease-in-out`.
- **Duration:** micro 50-100ms, short 150-250ms. Nothing longer.
- No entrance animation, no scroll-driven effects, no skeleton shimmer.

## Print — the screen is the exhibit

Adopted as **R3**. Every record and every queue gets a real `@media print` sheet.

- **No second template.** A separate PDF export path silently drifts from the UI,
  and drift between the screen and the printout is exactly what gets torn apart in
  a proceeding.
- **Every printed page carries provenance in the footer:** register ID, the paper
  form's date, the digitisation timestamp, and the payload hash. Example:
  `payload_hash 9f2a41c8e07b… · register 4f2a · Printed 2026-09-05 14:32 IST`.
- Print drops interactive chrome (nav, buttons, filters) and keeps rules, labels
  and tabular figures.
- Timestamps print in IST with the zone named. A date that shifts by a timezone is
  a wrong compliance record (see `README.md` invariant NFR-2).

## Accessibility floor

Non-negotiable, and already met. Do not regress:

- Focus ring is always visible: `2px solid var(--blue)`, `outline-offset: 2px`.
  This app is used all day by keyboard.
- Controls are 16px type and 44px tall minimum.
- Contrast passes AA: muted 5.58:1, link 6.10:1.
- Errors are announced, not only coloured.
- A neutral `Callout` carries a border, because `bg-canvas` **is** the body
  background and a borderless neutral callout is invisible against it.

## AI slop — the standing check

The last audit scored A on all 11 blacklist patterns. Keep it. Never introduce:
purple or violet gradients, a 3-column feature grid with icons in circles,
centered-everything, uniform bubble radius, gradient CTAs, stock-photo heroes,
`system-ui` as the display face, or "Built for X" copy.

## Considered and declined

Recorded so nobody re-proposes them cold in six months.

| Proposal | Why it was attractive | Why declined |
|---|---|---|
| **Source Serif 4 on `h1`/`h2`** | Closes the audit's one standing typography ding: Inter at 28px says *dashboard*, and this needs to say *record*. Scoped to h1/h2 only. | Inter stays. Revisit only alongside Indic translations, which would need Noto Serif Devanagari paired since Source Serif 4 has no Devanagari. |
| **Receipts instead of toasts** | A toast is ephemeral and this product's whole claim is that nothing here is. A persistent inline receipt per mutation would teach the thesis through the interaction model, and kill the "did that save?" bug. | Deferred, not rejected. Touches all three queue components. Reconsider when a queue gains a fourth action. |
| **Dark mode** | Category expectation. | Surface area no reader asked for. Read under office lighting and on phones. |

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-05 | Design system codified rather than redesigned | An audit had already graded the implemented system B+ design / A slop. What it lacked was a written form, which is why it had begun to drift. |
| 2026-09-05 | Type scale gains a real middle: 28/20/16/14/12 | `h2` was byte-identical to body at 14px and no `h3` existed, so evidence had no hierarchy it could be read at. |
| 2026-09-05 | `--canvas` warmed `#f6f7f9` → `#f7f6f3` (R2) | Cool grey is the SaaS tell. A warm ground makes a panel read as a sheet on a desk. One token, reversible. |
| 2026-09-05 | Print is the export (R3) | A second PDF template drifts from the UI, and that drift is what fails under examination. |
| 2026-09-05 | Inter retained as display face | Deliberate. The alternative is recorded above. |
| 2026-09-05 | One Panel, two paddings (16 dense / 24 calm) | 12 hand-rolled shells across 5 paddings is not a system. |
| 2026-09-05 | Ghost buttons underline on hover | The codebase already voted 8 to 1 for `hover:underline` over `hover:bg-blue-soft`. |
