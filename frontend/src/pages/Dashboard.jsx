import { Link } from 'react-router-dom';
import { api, useLiveData } from '../api.js';
import { money, STATUS_LABEL } from '../format.js';
import { StatusBadge } from '../components/ui.jsx';

const pct = (v) => (v == null ? '—' : `${v}%`);
const num = (v) => (v == null ? '—' : v);

/** Buyer dashboard: the assignment's success metrics (bids per RFQ, price improvement, extended vs not). */
export default function Dashboard() {
  const { data, error, loading } = useLiveData(api.dashboard, null);
  if (loading) return <p className="muted">Loading dashboard…</p>;
  if (error) return <p className="error">{error.message}</p>;
  const { totals, averages, extendedVsNot, rfqs } = data;
  const ext = extendedVsNot.extended;
  const notExt = extendedVsNot.notExtended;
  const maxSavings = Math.max(ext.avgSavingsPct ?? 0, notExt.avgSavingsPct ?? 0, 1);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Averages cover finished auctions (closed or awarded) with at least one bid. Savings = opening lowest quote − final L1.</p>
        </div>
      </div>

      <div className="stats">
        <div className="stat"><span className="label">RFQs</span><strong>{totals.rfqs}</strong>
          <span className="small muted">{Object.entries(totals.byStatus).map(([k, v]) => `${v} ${STATUS_LABEL[k].toLowerCase()}`).join(' · ')}</span></div>
        <div className="stat"><span className="label">Avg bids per RFQ</span><strong>{num(averages.bidsPerRfq)}</strong></div>
        <div className="stat"><span className="label">Avg supplier participation</span><strong>{pct(averages.participationPct)}</strong>
          <span className="small muted">{num(averages.suppliersPerRfq)} suppliers per RFQ</span></div>
        <div className="stat"><span className="label">Avg price improvement</span><strong className="good">{pct(averages.savingsPct)}</strong></div>
      </div>

      <div className="card">
        <h2>Extended vs non-extended auctions</h2>
        <p className="muted small">Do late-bid extensions lead to better final prices? (Success metric from the brief.)</p>
        <div className="compare">
          {[['Extended', ext, 'bar-ext'], ['Not extended', notExt, 'bar-noext']].map(([label, g, cls]) => (
            <div key={label} className="compare-row">
              <div className="compare-label"><strong>{label}</strong><span className="small muted">{g.count} auction(s) · {num(g.avgBidsPerRfq)} bids avg</span></div>
              <div className="bar-track"><div className={`bar ${cls}`} style={{ width: `${((g.avgSavingsPct ?? 0) / maxSavings) * 100}%` }} /></div>
              <div className="compare-value">{pct(g.avgSavingsPct)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>RFQ</th><th>Status</th><th className="num">Bids</th><th className="num">Suppliers</th><th className="num">Extensions</th>
            <th className="num">Opening lowest</th><th className="num">Final L1</th><th className="num">Saved</th></tr></thead>
          <tbody>
            {rfqs.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/rfqs/${r.id}`} className="strong">{r.name}</Link><div className="muted small">{r.reference_id}</div></td>
                <td><StatusBadge status={r.status} /></td>
                <td className="num">{r.metrics.bidCount}</td>
                <td className="num">{r.metrics.supplierCount}/{r.metrics.invitedCount}</td>
                <td className="num">{r.metrics.extensionCount}</td>
                <td className="num">{money(r.metrics.openingLowestMinor, r.currency)}</td>
                <td className="num">{money(r.metrics.finalL1Minor, r.currency)}</td>
                <td className="num good">{money(r.metrics.savingsMinor, r.currency)}<div className="small muted">{pct(r.metrics.savingsPct)}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
