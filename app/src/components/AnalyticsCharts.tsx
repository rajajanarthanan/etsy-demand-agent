"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type NoiseRow = {
  category: string;
  noise: number;
  listings: number;
  makeable: boolean;
};

type PriceRow = {
  category: string;
  medianPrice: number;
  listings: number;
};

export function AnalyticsCharts({
  categoryNoise,
  priceBands,
}: {
  categoryNoise: NoiseRow[];
  priceBands: PriceRow[];
}) {
  return (
    <div className="stack-sm">
      <div>
        <h2>Category noise (US)</h2>
        <p className="muted" style={{ margin: 0 }}>
          Proxy demand signal by category — not verified unit sales.
        </p>
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={categoryNoise} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid stroke="rgba(196,214,180,0.12)" vertical={false} />
              <XAxis
                dataKey="category"
                tick={{ fill: "#a3b39a", fontSize: 11 }}
                interval={0}
                angle={-28}
                textAnchor="end"
                height={70}
              />
              <YAxis tick={{ fill: "#a3b39a", fontSize: 11 }} width={48} />
              <Tooltip
                contentStyle={{
                  background: "#243022",
                  border: "1px solid rgba(196,214,180,0.25)",
                  borderRadius: 8,
                }}
              />
              <Bar dataKey="noise" fill="#c4a35a" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div>
        <h2>Median price by category</h2>
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={priceBands} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid stroke="rgba(196,214,180,0.12)" vertical={false} />
              <XAxis
                dataKey="category"
                tick={{ fill: "#a3b39a", fontSize: 11 }}
                interval={0}
                angle={-28}
                textAnchor="end"
                height={70}
              />
              <YAxis tick={{ fill: "#a3b39a", fontSize: 11 }} width={48} />
              <Tooltip
                contentStyle={{
                  background: "#243022",
                  border: "1px solid rgba(196,214,180,0.25)",
                  borderRadius: 8,
                }}
              />
              <Bar dataKey="medianPrice" fill="#7ea36d" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
