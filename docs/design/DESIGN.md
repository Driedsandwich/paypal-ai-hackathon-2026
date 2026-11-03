# Okuri visual design target (chosen 2026-11-01)

Two generated mockups define the target. They are static images made for this project
(not screenshots of the app, not copied from any other product).

- **Skeleton (information structure): S3 "Transaction journey"** —
  `target-skeleton-S3-journey-desktop.png`, `target-skeleton-S3-journey-mobile.png`.
  Rendered in a neutral white/vermilion style on purpose: take the *structure* from it.
- **Style (look): A1 "Paper & seal"** —
  `target-style-A1-paper-seal-desktop.png`, `target-style-A1-paper-seal-mobile.png`.
  Built on a different skeleton (a dashboard): take only the *look* from it.
- Secondary references (use only where noted below): `ref-skeleton-S1-inbox-desktop.png`
  (approvals list view), `ref-skeleton-S4-map-desktop.png` (map idea for the insights view).

The owner's direction: base everything on S3; where it fits, borrow elements from the other
skeletons; apply the A1 look; switchable themes ("skins") only if time allows later.

## 1. Skeleton: S3 transaction journey (home)

One sale at a time, followed from the seller in Japan to the buyer abroad.

| Region | Role | Content | Components |
| --- | --- | --- | --- |
| Header + counts | entry points and workload | Journeys / Approvals / Insights / New item; stage counts (Draft, Invoiced, Paid, Shipped, Disputed); "PayPal sandbox" and model ("Claude") labels | top nav, count strip, text badges |
| Sale heading | pins the sale being followed | order no., Japanese item name, buyer alias, country, total | Previous / Next, centered title |
| Horizontal journey | completed / current / future steps | Japan (seller) → buyer country; steps Draft · Invoice · Paid · Tracking · Delivered | connecting line, numbered step marks, state labels |
| Step callout | ties AI work to the step where it is needed | e.g. invoice draft with total and Approve; "add tracking after shipment" | callout attached to its step, Review, Approve |
| Exception branch | separates disputes from the normal path | "If disputed → evidence + reply" | dashed branch, evidence card with its own Approve |
| Activity log | what actually happened | timestamped rows | plain rows |

Seller's day on this skeleton: New item opens a journey (Draft holds the English listing and
USD price) → Invoice step callout → Approve sends the invoice → Paid completes → Tracking step
asks for the number, AI checks it, Approve registers it → a dispute opens the branch from
the step where it happened; evidence and reply are approved on the branch. Never reuse
"Delivered" to mean "dispute resolved".

Mobile: keep the horizontal step navigation with the current step's card (show a sliver of
the previous/next steps as a swipe hint). Do not turn the journey into a generic vertical
card list. The open menu must not hide the current sale and step.

Other views (borrowed skeleton elements):
- **Approvals**: an inbox-style list of every pending proposal across sales (S1: list on the
  left, selected proposal on the right). Each row links back to its journey step.
- **Insights**: AG Studio dashboard (revenue by country, unpaid invoices, dispute rate).
  A country map widget in the spirit of S4 if AG Studio supports it; otherwise a bar chart.
- **New item** and **Disputes** detail screens follow the same look.

## 2. Style: A1 paper & seal

Colors

| Role | Hex |
| --- | --- |
| Off-white background | `#F6F1E7` |
| Paper surface | `#FFFCF6` |
| Ink (body text) | `#252522` |
| Secondary text | `#666259` |
| Rules / borders | `#D6CEBE` |
| Single accent (vermilion) | `#B43F31` |

State colors are fixed tokens separate from decoration: error `#B42318`, warning `#8A5A00`,
success `#21734B`. Always pair color with an icon and text. Reject is never error-colored.

Type: two families only — Noto Serif JP (headings, ledger numbers) and Noto Sans JP (menus,
controls, body). Desktop headings 48/28/22 px, mobile 32/22/18 px; counts 32/22 px; body
16/14 px; secondary 13/12 px (never below 12); buttons 16 px. Line height: body 1.4–1.5,
headings 1.15–1.25. `font-variant-numeric: tabular-nums` for money and counts.

Spacing on a 4 px scale: 4/8 small, 12/16 between elements, 24/32 between regions. Mobile
outer margin 16 px; touch targets at least 44×44 px; at least 8 px between Approve and Reject.

Components
- Step marks: line icons, label, count, thin connectors. Not five filled cards.
- Approval items: ledger-like rows or callouts with rules, not heavy cards. The "seal" mark next to
  the wordmark is decorative only: a filled vermilion square stamp with a white 送 ("send", as in
  Okuri), tilted 4° with a light stamped texture, also used as the favicon. The glyph is an outline
  path from Noto Serif JP Bold (OFL-1.1), not live text. Changed on 2026-11-04 by the owner's
  choice; it was an outline square, which could read as a missing-glyph box or a checkbox.
- Buttons: Approve = vermilion fill; Reject / secondary = ink outline; radius 2–4 px.
- Navigation: selected item marked by a vermilion rule and a lighter paper tone.
- Subtle paper texture is allowed only if body contrast stays high (WCAG AA).

## 3. Finish checklist
- [ ] Two type families at most; one accent color.
- [ ] Cards are not the default container; rules and rows first.
- [ ] One role per region (do not mix analytics into approval rows).
- [ ] Error colors, focus rings, disabled states and approval conditions are not restyled for
      decoration.
- [ ] Mobile: menu open state, current step visible, no horizontal/vertical scroll trap.
- [ ] Empty, loading, error, long Japanese titles and long buyer names handled.
- [ ] Screenshots at 1440×900 and 390×844 compared side by side with both targets.
