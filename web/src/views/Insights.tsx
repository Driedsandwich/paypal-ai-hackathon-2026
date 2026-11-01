import type { ViewProps } from "../App";

/** Placeholder; replaced by the AG Studio dashboard. */
export function InsightsView({ data }: ViewProps) {
  return (
    <div className="form-page">
      <header className="page-head"><h1 className="serif">Insights</h1></header>
      <p className="muted">{data?.journeys.length ?? 0} sales.</p>
    </div>
  );
}
