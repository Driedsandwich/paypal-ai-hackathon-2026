import { useMemo } from "react";
import { AgStudio } from "ag-studio-react";
import { AgStudioLicenseManager, studioTheme } from "ag-studio";
import { money } from "../api";
import { byCountry, insightCards, insightRows, ledgerTracks, studioFrameHeight, type InsightRow } from "../insights-data";
import type { ViewProps } from "../App";

// Insights with AG Studio (AG Grid's embedded analytics): revenue by buyer country, unpaid
// invoices and the dispute rate, computed in the browser from the sales on this demo. A
// pre-built report in view mode; the A1 tokens are passed to AG Studio's theming API.
// AG Studio has no map widget, so "where buyers are" (S4) is a bar chart plus a country ledger.

const INK = "#252522";
const INK_2 = "#666259";
const RULE = "#D6CEBE";
const BG = "#F6F1E7";
const PAPER = "#FFFCF6";
const ACCENT = "#B43F31";
const UI_FONT = '"Noto Sans JP", sans-serif';
const TITLE_FONT = '"Noto Serif JP", serif';

let licenseApplied = false;
function applyLicense(key: string | undefined): void {
  if (licenseApplied || !key) return;
  AgStudioLicenseManager.setLicenseKey(key);
  licenseApplied = true;
}

const usd = { format: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }) };
const title = (text: string) => ({ enabled: true, text, typography: { fontFamily: TITLE_FONT, fontSize: 18, fontWeight: 700 }, color: INK });

function studioData(rows: InsightRow[]) {
  return {
    sources: [
      {
        id: "sales",
        data: rows,
        fields: [
          { id: "sale", name: "Sale", format: "textFormat" },
          { id: "invoice", name: "Invoice", format: "textFormat" },
          { id: "item", name: "Item", format: "textFormat" },
          { id: "country", name: "Country", format: "textFormat" },
          { id: "revenue_usd", name: "Revenue", format: "currencyFormat", formatOptions: usd },
          { id: "unpaid_usd", name: "Unpaid", format: "currencyFormat", formatOptions: usd },
          { id: "days_outstanding", name: "Days open", format: "integerFormat" },
          { id: "disputed", name: "Disputes", format: "integerFormat" },
          { id: "paid", name: "Paid sales", format: "integerFormat" },
        ],
      },
    ],
    expressions: [
      {
        id: "dispute_rate",
        name: "Dispute rate",
        isMeasure: true,
        format: "percentageFormat",
        formatOptions: { format: "0.0%" },
        expression: { operator: "divide", inputs: [{ id: "sales.disputed", aggregation: "sum" }, { id: "sales.paid", aggregation: "sum" }] },
      },
    ],
  };
}

function initialState(ledgerYSpan: number) {
  return {
  selectedPageId: "insights",
  pages: [
    {
      id: "insights",
      widgets: {
        revenue: {
          type: "bar-chart-grouped",
          dataMapping: { categoryKey: [{ id: "sales.country" }], valueKey: [{ id: "sales.revenue_usd", aggregation: "sum" }] },
          format: { title: title("Revenue by buyer country (USD, paid)"), style: { theme: { common: { legend: { enabled: false } } } } },
        },
        unpaid: {
          type: "grid",
          dataMapping: { cols: [{ id: "sales.invoice" }, { id: "sales.country" }, { id: "sales.unpaid_usd" }, { id: "sales.days_outstanding" }] },
          format: { title: title("Unpaid invoices") },
        },
        rate: {
          type: "value",
          dataMapping: { value: [{ id: "dispute_rate" }] },
          format: { title: title("Dispute rate"), style: { color: ACCENT, typography: { fontFamily: TITLE_FONT } } },
        },
        ledger: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "sales.country" },
              { id: "sales.revenue_usd", aggregation: "sum" },
              { id: "sales.unpaid_usd", aggregation: "sum" },
              { id: "sales.disputed", aggregation: "sum" },
            ],
          },
          format: { title: title("By country") },
        },
      },
      widgetLayout: {
        revenue: { xTrack: 0, yTrack: 0, xSpan: 10, ySpan: 18 },
        unpaid: { xTrack: 10, yTrack: 0, xSpan: 8, ySpan: 18 },
        rate: { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 18 },
        ledger: { xTrack: 0, yTrack: 18, xSpan: 24, ySpan: ledgerYSpan },
      },
      filter: {
        widget: {
          revenue: [{ field: { id: "sales.revenue_usd" }, model: { operator: "greaterThan", value: 0 } }],
          unpaid: [{ field: { id: "sales.unpaid_usd" }, model: { operator: "greaterThan", value: 0 } }],
        },
      },
    },
  ],
  };
}

const THEME = studioTheme.withParams({
  backgroundColor: BG,
  foregroundColor: INK,
  textColor: INK,
  subtleTextColor: INK_2,
  borderColor: RULE,
  accentColor: ACCENT,
  borderRadius: 2,
  fontFamily: UI_FONT,
  studioWrapperBorder: false,
  studioCanvasBorder: false,
  studioWrapperBackgroundColor: BG,
  studioCanvasBackgroundColor: BG,
  studioCanvasFontFamily: UI_FONT,
  studioWidgetBackgroundColor: PAPER,
  studioWidgetBorder: { width: 1, color: RULE },
  studioWidgetBorderRadius: 3,
  studioWidgetTitleFontFamily: TITLE_FONT,
  studioWidgetTitleFontSize: 18,
  studioWidgetTitleTextColor: INK,
  studioWidgetSubtitleTextColor: INK_2,
  studioWidgetCaptionTextColor: INK_2,
  studioValueWidgetFontSize: 56,
  gridFontFamily: UI_FONT,
  gridHeaderFontFamily: UI_FONT,
  gridCellFontFamily: UI_FONT,
  gridHeaderTextColor: INK_2,
  gridCellTextColor: INK,
  gridHeaderBackgroundColor: PAPER,
  gridDataBackgroundColor: PAPER,
  gridOddRowBackgroundColor: PAPER,
  gridRowBorder: { width: 1, color: RULE },
  gridHeaderRowBorder: { width: 1, color: RULE },
  gridWrapperBorder: false,
  gridWrapperBorderRadius: 2,
  gridAccentColor: ACCENT,
  chartFontFamily: UI_FONT,
  chartTextColor: INK,
  chartSubtleTextColor: INK_2,
  chartAxisLineColor: RULE,
  chartGridLineColor: RULE,
  chartAccentColor: ACCENT,
  chartPaletteFills1Color: ACCENT,
  chartPaletteStrokes1Color: ACCENT,
} as never);

export function InsightsView({ health, data, dataError }: ViewProps) {
  applyLicense(health.agStudio.licenseKey);
  const rows = useMemo(() => insightRows(data?.journeys ?? []), [data]);
  const studio = useMemo(() => studioData(rows), [rows]);
  const tracks = ledgerTracks(byCountry(rows).size);
  const state = useMemo(() => initialState(tracks), [tracks]);
  const { paid, disputed, revenue, unpaid } = insightCards(rows);

  return (
    <div className="insights">
      <header className="page-head">
        <h1 className="serif">Insights</h1>
        <p className="muted">From the sales on this demo ({rows.length} in USD). Built with AG Studio{health.agStudio.licensed ? "" : " (trial: no AG_STUDIO_LICENSE set)"}.</p>
      </header>
      {/* Plain summary first: readable on any screen and for screen readers. */}
      <dl className="insight-summary">
        <div><dt>Paid revenue</dt><dd className="serif">{money({ currency_code: "USD", value: revenue.toFixed(2) })}</dd></div>
        <div><dt>Unpaid</dt><dd className="serif">{money({ currency_code: "USD", value: unpaid.toFixed(2) })}</dd></div>
        <div><dt>Dispute rate</dt><dd className="serif accent">{paid ? `${((disputed / paid) * 100).toFixed(1)}%` : "–"}</dd><dd className="muted small">{disputed} of {paid} paid sales</dd></div>
      </dl>
      {dataError ? <p className="empty-note">The sales could not be loaded.</p> : null}
      {!data && !dataError && <p className="loading" aria-busy="true">Loading…</p>}
      {data && rows.length === 0 && <p className="empty-note">No data yet. Insights appear once a sale has an invoice.</p>}
      {data && rows.length > 0 && (
        <div className="studio-scroll">
          <div className="studio-frame" style={{ height: studioFrameHeight(tracks) }}>
            <AgStudio
              key={`${rows.length}-${tracks}`}
              style={{ height: "100%", width: "100%" }}
              mode="view"
              data={studio as never}
              initialState={state as never}
              theme={THEME}
              panels={{ view: { left: [], right: [] } }}
              layout={{ backgroundColor: BG, widgetBackgroundColor: PAPER, widgetBorderColor: RULE, widgetBorderRadius: 3 } as never}
            />
          </div>
        </div>
      )}
    </div>
  );
}
