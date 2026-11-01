# Layout table (pass 2)

Written before the UI code. Structure comes from S3 (`target-skeleton-S3-journey-*.png`); the
look (colors, type, components) only from A1 (`target-style-A1-paper-seal-*.png`). S1 and S4
are borrowed only where `DESIGN.md` says so. "S3-D" = S3 desktop image, "S3-M" = S3 mobile,
"A1-D"/"A1-M" = A1 desktop/mobile, "S1-D", "S4-D" likewise. Positions are given as they
appear in the 1440×900 / 390×844 images.

## Design tokens (from A1 only)

| Token | Value | Taken from |
| --- | --- | --- |
| Background | `#F6F1E7` off-white | A1-D page background |
| Surface | `#FFFCF6` paper | A1-D sidebar and rows |
| Ink / secondary | `#252522` / `#666259` | A1-D headings / "Your international sales cockpit." |
| Rules | `#D6CEBE` 1 px | A1-D row separators and the rule under the count strip |
| Accent | `#B43F31` vermilion | A1-D Approve buttons, counts badge, "1.8%" |
| State | error `#B42318`, warning `#8A5A00`, success `#21734B` | DESIGN.md §2 (not in the images) |
| Headings, ledger numbers | Noto Serif JP 700 | A1-D "Home", "Awaiting approval", "01/02/03", counts "08 12 06" |
| UI and body | Noto Sans JP 400/700 | A1-D menu, buttons, row subtitles |
| Sizes | headings 48/28/22 desktop, 32/22/18 mobile; counts 32/22; body 16/14; secondary 13/12 | DESIGN.md §2 |
| Buttons | Approve: vermilion fill, white text; Reject/secondary: ink outline; radius 3 px; 44 px high | A1-D/A1-M Approve/Reject pairs |
| Selected nav | vermilion rule + lighter paper tone | A1-D sidebar "Home" (here as a bottom rule on a top tab, S3 layout) |
| Seal | small hollow vermilion square next to the wordmark, decorative, `aria-hidden` | A1-D "Okuri ☐" |
| Step marks | thin-line circles with number; done = ink fill + check; current = vermilion fill; future = rule outline | S3-D structure, A1 line weight and colors |

## Global shell (every view)

| Region | Role | Content | Component | Copies |
| --- | --- | --- | --- | --- |
| Header left | identity | "Okuri" serif wordmark + seal square | `<header>` row | S3-D top-left "Okuri" (position); A1-D wordmark + seal (look) |
| Header nav | entry points | Journeys · Approvals (pending count badge) · New item · Disputes · Insights | tab row, selected = vermilion underline | S3-D "Journeys / Archive" tabs; count badge from A1-D "Approvals 3" |
| Header right | environment and model labels | "+ New item" (vermilion, desktop only), chip "PayPal sandbox" (plus "· offline" when the in-memory simulator runs), chip with the configured model's display name ("Claude"; "Offline AI" with the fake provider) and, when set, "→ Gemini" for the fallback | chips with rule border | S3-D top-right "+ New item / PayPal sandbox / Claude" |
| Notice line | honesty | "Nothing is sent until you approve." + demo-mode notice; banner rows for missing configuration | one muted line under the header, banner rows in warning color with icon | A1-D top-right "Nothing is sent until you approve." |
| Count strip | workload by stage | Draft · Invoiced · Paid · Shipped · Disputed with line icons and serif counts | five cells separated by rules (no cards) | S3-D count strip (position, one row); A1-D icons + serif numerals |
| Mobile header | compact entry | wordmark left, "Menu ☰ / ×" right; menu opens **inline** (tabs, New item, chips) and pushes content down by one block so the sale heading and step stay on screen | disclosure button, `aria-expanded` | S3-M "Okuri  Menu ×" open state |

## Journey home (S3)

| Region | Role | Content | Component | Copies |
| --- | --- | --- | --- | --- |
| Sale heading | pins the sale being followed | `OK-1042 · 手作りの花器` (sale number + Japanese item name; English name below in secondary), buyer alias · country · total; "n of m" | centered serif title, ← Previous / Next → outline buttons | S3-D centered "OK-1042 · 手作りの花器 / Mira Vale · United States · USD $128.00" and Previous/Next; S3-M stacked title with ‹ › |
| Journey ends | where the parcel goes | "Japan / Seller" left, buyer country / "Buyer" right | text labels at the track ends | S3-D "Japan Seller" … "United States Buyer" |
| Journey track | completed / current / future | 1 Draft · 2 Invoice · 3 Paid · 4 Tracking · 5 Delivered, each with a state label (e.g. "English listing ready", "Awaiting approval", "Waiting for buyer") | horizontal line, vermilion up to the current step, numbered marks | S3-D track |
| Step callout | AI work attached to the step that needs it | model name · state ("Claude · Draft ready"), English title, item/total lines, Review + Approve (pending proposal of this visitor) or the next action ("Prepare invoice", "Add tracking", "Simulate buyer payment" offline) | callout box with a pointer to its step | S3-D callout above step 2; S3-D small "Claude / Add tracking after shipment" hint above step 4 |
| Dispute branch | exceptions apart from the normal path | dashed line from the step where the dispute happened (Tracking if tracking was added, else Paid) to an "Evidence + reply" card (status, reason, amount, Build evidence pack / Approve) | dashed connector + bordered card with document icon | S3-D "If disputed → Evidence + reply" |
| Activity log | what actually happened | time + text rows, newest last, at most 8 shown | ruled rows on paper | S3-D "Activity log" |
| Mobile track | keep the journey horizontal | three steps visible (previous, current, next) with a sliver of the rest; ‹ › and dots below; "Swipe to …" hint | horizontal scroller with snap | S3-M steps 1-3 + "Swipe to Tracking and Delivered →" |

## Approvals (S1 inbox, A1 look)

| Region | Role | Content | Component | Copies |
| --- | --- | --- | --- | --- |
| Inbox header | how much waits | "Approval inbox" + count; status filter (Needs approval / Done / All); search box | serif heading, select, search input | S1-D "Approval inbox 4", "Needs approval ▾", search |
| Inbox rows | every pending proposal across sales | ledger number 01/02…, icon by kind, action title ("Send invoice"), sale no. · item · country, one-line AI note | ruled rows; selected = vermilion left rule + lighter paper | S1-D left list; A1-D "01 / Send invoice / #1042 · Maya Ellis" rows |
| Detail heading | the proposal in focus | action title, sale no. · buyer alias · country, status tag | serif heading + tag | S1-D "Send invoice / OK-1042 · Mira Vale · United States / Needs approval" |
| Detail body | what will be sent, in human terms | invoice: item, amounts, total; reminder: invoice no. + Copy-for-DM; tracking: carrier + number; evidence: notes + attachments + reply; "Exact payload sent to PayPal" disclosure | ledger table inside a ruled block (not a heavy card) | S1-D "INVOICE DRAFT" block |
| AI note | who wrote what | model chip + one sentence ("I prepared the English listing and USD price. Review before sending.") | chip + text row | S1-D "Claude  I prepared…" |
| Mini progress | where this sits in the sale | Item added → Draft prepared → Awaiting approval, link "Open journey step" | three small marks | S1-D bottom three marks |
| Action bar | the decision | consequence sentence ("Sends a PayPal invoice to Demo buyer 1."), Reject (outline), Approve (vermilion), ≥ 8 px apart | sticky bar at the bottom of the detail | S1-D "Sends a PayPal invoice to Mira Vale. / Edit draft / Approve" |
| Mobile | list first, detail on tap with "← Inbox" | — | single column | A1-M stacked approval rows |

## New item

| Region | Role | Content | Component | Copies |
| --- | --- | --- | --- | --- |
| Heading | what this does | "New item" + "Type it in Japanese; the AI drafts the English listing." | serif heading + secondary line | A1-D "Home / Your international sales cockpit." |
| Sample picker | quick start for judges | the four sample items as chips | outline chips | — (A1 chip style) |
| Japanese form | seller input | title, description, price (JPY), condition, category, weight | labelled fields, 44 px inputs | A1 controls |
| Draft result | AI output to check | English title, description, item specifics (ledger rows), USD estimate with FX note, customs line, HS candidate "check before use" (warning icon + text), model chip | ruled ledger block | S1-D "INVOICE DRAFT" block look |
| Bill the buyer | start the journey | demo buyer alias, buyer country, price; "Prepare invoice for approval" → opens the journey at step 2 | form row + vermilion button | S3-D step 2 callout (destination) |

## Disputes

| Region | Role | Content | Component | Copies |
| --- | --- | --- | --- | --- |
| List | open cases | dispute id, reason, stage, amount, due date, linked sale no. | ruled rows (A1 ledger) | A1-D approval rows look |
| Detail | the case | status, allowed actions, buyer messages (redacted), facts form (invoice, tracking, notes) | ruled block | S3-D "Evidence + reply" card, expanded |
| Evidence pack | AI output | summary, timeline, reply draft, unverified facts in error color with icon, attachments | ledger block + proposals with Approve/Reject | S1-D detail body + action bar |

## Insights (AG Studio; S4 idea)

| Region | Role | Content | Component | Copies |
| --- | --- | --- | --- | --- |
| Heading | — | "Insights" + "From the sales on this demo" | serif heading | A1-D heading style |
| Revenue by country | where money comes from | paid revenue (USD) per buyer country | AG Studio bar chart widget, vermilion bars on paper | A1-D "Sales by country" bars; S4-D per-country summary (no map widget in AG Studio, see below) |
| Unpaid invoices | what to chase | invoice no., amount, days outstanding | AG Studio grid widget | A1-D "Unpaid invoices" table |
| Dispute rate | risk | disputed sales / paid sales, "n of m" | AG Studio KPI widget | A1-D "Dispute rate 1.8% / 1 of 56" |
| Country ledger | S4 bottom strip | per-country sales, unpaid, disputes | AG Studio grid widget | S4-D bottom "United States / Sales / Unpaid / Disputes" strip |

## States the targets do not show

| State | Handling |
| --- | --- |
| Empty (no sales yet) | Journey home shows the empty track (all five steps as future) with a callout "No sale yet: start with New item" and, when PayPal is configured, "Seed demo data (approval needed)". Approvals: "Nothing waits for you. Proposals appear here when the AI prepares something." Disputes: "No disputes. They appear here when a buyer opens one." Insights: widgets show "No data yet". |
| Loading | Text placeholder lines in rule color with "Loading…" for screen readers (`aria-busy`); buttons show "Working…" and are disabled while an action runs. |
| Error | Error row in error color with an "!" icon and text, PayPal `debug_id` when present, retry hint for limits; never uses the accent color. A failed/obsolete/unknown proposal shows its message in the callout instead of Approve. |
| Long Japanese titles | Sale heading wraps to at most 2 lines (`line-clamp: 2`), full title in `title`; inbox rows clamp to 1 line with ellipsis; `word-break: auto-phrase` / `overflow-wrap: anywhere` so Japanese breaks cleanly. |
| Long buyer names / aliases | Single line with ellipsis in rows and the sale heading (`min-width: 0` on flex children); full text in `title`. |
| Mobile menu open | Inline disclosure under the header (tabs + New item + chips in two rows); the count strip, sale heading and current step remain visible below it at 390×844; `Esc` and the × close it. |
| Sale with a dispute | Track shows steps normally; the dispute branch starts at the Tracking step (or Paid if no tracking) with a dashed connector to the evidence card; the count strip counts it under Disputed; "Delivered" is never used to mean "dispute resolved". |
| Proposal not pending (executed / rejected / failed / obsolete / unknown / expired) | Callout and inbox show the status tag with icon and text; only pending proposals show Approve/Reject. |
| Offline simulator | "PayPal sandbox · offline" chip and a banner line: nothing reaches PayPal; "Simulate buyer payment" / "Simulate dispute" buttons only in this mode. |
| Reduced motion / keyboard | No animation beyond scroll-snap; visible focus ring (2 px ink outline, not restyled); all actions are buttons. |
