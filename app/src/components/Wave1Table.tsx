"use client";

type Wave1Row = {
  category: string;
  combined_noise: number;
  us_noise: number | null;
  ca_noise: number | null;
  us_median_price: number | null;
  us_reviews_30d: number | null;
  example_us: { title: string; url: string; price: number | null } | null;
};

export function Wave1Table({ rows }: { rows: Wave1Row[] }) {
  return (
    <div>
      <h2>Wave‑1 makeable shortlist</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Prefer named categories over <code>other_wood</code> for production briefs.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Noise</th>
              <th>US median</th>
              <th>Reviews 30d</th>
              <th>Example</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.category}>
                <td>
                  {r.category}
                  {r.category === "other_wood" ? " ⚠" : ""}
                </td>
                <td>{r.combined_noise.toFixed(1)}</td>
                <td>
                  {r.us_median_price != null
                    ? `$${r.us_median_price.toFixed(2)}`
                    : "—"}
                </td>
                <td>{r.us_reviews_30d ?? "—"}</td>
                <td>
                  {r.example_us ? (
                    <a href={r.example_us.url} target="_blank" rel="noreferrer">
                      {r.example_us.title.slice(0, 64)}
                      {r.example_us.title.length > 64 ? "…" : ""}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
