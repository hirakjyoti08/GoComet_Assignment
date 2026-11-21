import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { money, dateTime, date } from '../format.js';
import { StatusBadge, Clock, Timeline, ConfigSummary, ActivityLog, Field, ErrorText } from '../components/ui.jsx';

// ---------- action bar: edit / pause / resume / cancel ----------

function Actions({ rfq, status, reload }) {
  const [mode, setMode] = useState(null); // 'cancel'
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); setMode(null); setReason(''); reload(); } catch (e) { setError(e.details?.reason || e.message); } finally { setBusy(false); }
  };
  const canCancel = !['CANCELLED', 'AWARDED'].includes(status);
  if (!canCancel && status !== 'UPCOMING') return null;

  return (
    <div className="action-bar">
      <div className="action-buttons">
        {status === 'UPCOMING' && <Link to={`/rfqs/${rfq.id}/edit`} className="btn">Edit RFQ</Link>}
        {status === 'ACTIVE' && <button className="btn" disabled={busy} onClick={() => run(() => api.pause(rfq.id))}>Pause bidding</button>}
        {status === 'PAUSED' && <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.resume(rfq.id))}>Resume bidding</button>}
        {canCancel && mode !== 'cancel' && <button className="btn btn-danger-ghost" onClick={() => setMode('cancel')}>Cancel RFQ</button>}
      </div>
      {mode === 'cancel' && (
        <div className="inline-confirm">
          <Field label="Reason for cancelling (shown to invited suppliers)">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Shipment postponed" autoFocus />
          </Field>
          <div className="actions">
            <button className="btn" onClick={() => setMode(null)}>Keep RFQ</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => run(() => api.cancel(rfq.id, reason))}>Confirm cancel</button>
          </div>
        </div>
      )}
      <ErrorText error={error} />
    </div>
  );
}

// ---------- award ----------

function AwardPanel({ rfq, reload }) {
  const l1 = rfq.ranking[0];
  const [supplierId, setSupplierId] = useState(l1?.supplier_id ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = rfq.ranking.find((r) => r.supplier_id === Number(supplierId));
  const needsReason = chosen && chosen.rank !== 1;

  if (!l1) return <div className="card banner">The auction closed without any bids, so there is nothing to award.</div>;

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api.award(rfq.id, Number(supplierId), reason); reload(); } catch (err) { setError(err.details?.reason || err.details?.supplierId || err.message); } finally { setBusy(false); }
  }

  return (
    <form className="card award-panel" onSubmit={submit}>
      <h2>Award this RFQ</h2>
      <p className="muted small">The auction has closed. Choose the winning supplier — L1 is pre-selected.</p>
      <div className="grid-2">
        <Field label="Winning supplier">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            {rfq.ranking.map((r) => (
              <option key={r.supplier_id} value={r.supplier_id}>L{r.rank} · {r.supplier_name} · {money(r.total_minor, rfq.currency)}</option>
            ))}
          </select>
        </Field>
        <Field label={needsReason ? 'Reason (required when not awarding L1)' : 'Note (optional)'}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={needsReason ? 'e.g. Faster transit time' : ''} />
        </Field>
      </div>
      <ErrorText error={error} />
      <div className="actions"><button className="btn btn-primary" disabled={busy}>{busy ? 'Awarding…' : `Award to ${chosen?.supplier_name ?? '…'}`}</button></div>
    </form>
  );
}

function AwardResult({ rfq }) {
  const a = rfq.award;
  return (
    <div className="card banner banner-success">
      <strong>Awarded to {a.supplier_name}</strong> at {money(a.bid?.total_minor, rfq.currency)} on {dateTime(a.awarded_at)}
      {!a.was_l1 && <span className="chip">not L1</span>}
      {a.reason && <div className="small">Reason: {a.reason}</div>}
    </div>
  );
}

// ---------- metrics ----------

function Metrics({ rfq }) {
  const m = rfq.metrics;
  return (
    <div className="card">
      <h2>Auction performance</h2>
      <div className="metric-grid">
        <div><span className="label">Bids</span><strong>{m.bidCount}</strong></div>
        <div><span className="label">Participation</span><strong>{m.supplierCount}/{m.invitedCount}</strong>
          <span className="small muted">{m.participationPct != null ? `${m.participationPct}%` : ''}</span></div>
        <div><span className="label">Opening lowest quote</span><strong>{money(m.openingLowestMinor, rfq.currency)}</strong></div>
        <div><span className="label">Current / final L1</span><strong>{money(m.finalL1Minor, rfq.currency)}</strong></div>
        <div><span className="label">Saved through bidding</span>
          <strong className={m.savingsMinor > 0 ? 'good' : ''}>{money(m.savingsMinor, rfq.currency)}</strong>
          <span className="small muted">{m.savingsPct != null ? `${m.savingsPct}%` : ''}</span></div>
        <div><span className="label">Extensions</span><strong>{m.extensionCount}</strong></div>
      </div>
    </div>
  );
}

// ---------- ranking (sortable) ----------

const SORTS = {
  rank: { label: 'Rank', fn: (a, b) => a.rank - b.rank },
  transit: { label: 'Transit time', fn: (a, b) => a.transit_time_days - b.transit_time_days || a.rank - b.rank },
  validity: { label: 'Quote validity', fn: (a, b) => b.quote_valid_until.localeCompare(a.quote_valid_until) || a.rank - b.rank },
};

function Ranking({ rfq }) {
  const [sort, setSort] = useState('rank');
  const [open, setOpen] = useState(null);
  const rows = useMemo(() => [...rfq.ranking].sort(SORTS[sort].fn), [rfq.ranking, sort]);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Supplier ranking</h2>
        {rfq.ranking.length > 1 && (
          <label className="sort small">Sort by{' '}
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
        )}
      </div>
      {rows.length === 0 ? <p className="muted">No bids yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Rank</th><th>Supplier</th><th className="num">Total</th><th className="num">Transit</th><th>Valid until</th><th></th></tr></thead>
            <tbody>
              {rows.map((b) => (
                <Fragment key={b.supplier_id}>
                  <tr className={b.rank === 1 ? 'row-l1' : ''}>
                    <td><span className={`rank rank-${Math.min(b.rank, 3)}`}>L{b.rank}</span></td>
                    <td><span className="strong">{b.supplier_name}</span><div className="muted small">{b.carrier_name}</div></td>
                    <td className="num strong">{money(b.total_minor, rfq.currency)}</td>
                    <td className="num">{b.transit_time_days} d</td>
                    <td>{date(b.quote_valid_until)}</td>
                    <td className="num"><button className="link" onClick={() => setOpen(open === b.supplier_id ? null : b.supplier_id)}>
                      {open === b.supplier_id ? 'Hide' : 'Details'}</button></td>
                  </tr>
                  {open === b.supplier_id && (
                    <tr className="detail-row">
                      <td colSpan={6}>
                        <dl className="quote">
                          <div><dt>Freight</dt><dd>{money(b.freight_charges_minor, rfq.currency)}</dd></div>
                          <div><dt>Origin</dt><dd>{money(b.origin_charges_minor, rfq.currency)}</dd></div>
                          <div><dt>Destination</dt><dd>{money(b.destination_charges_minor, rfq.currency)}</dd></div>
                          <div><dt>Transit time</dt><dd>{b.transit_time_days} days</dd></div>
                          <div><dt>Quote valid until</dt><dd>{date(b.quote_valid_until)}</dd></div>
                          <div><dt>Submitted</dt><dd>{dateTime(b.created_at)}</dd></div>
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- invitations ----------

function Invitations({ rfq, status, reload }) {
  const [all, setAll] = useState(null);
  const [picked, setPicked] = useState([]);
  const [error, setError] = useState('');
  const canInvite = ['UPCOMING', 'ACTIVE', 'PAUSED'].includes(status);
  const invitedIds = new Set(rfq.invitations.map((i) => i.supplier_id));
  const bidders = new Set(rfq.ranking.map((r) => r.supplier_id));

  const openPicker = () => api.suppliers().then((r) => setAll(r.suppliers)).catch((e) => setError(e.message));
  const submit = async () => {
    setError('');
    try { await api.invite(rfq.id, picked); setAll(null); setPicked([]); reload(); } catch (e) { setError(e.details?.supplierIds || e.message); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Invited suppliers <span className="muted small">({rfq.invitations.length})</span></h2>
        {canInvite && !all && <button className="link" onClick={openPicker}>+ Invite more</button>}
      </div>
      <ul className="invite-list">
        {rfq.invitations.map((i) => (
          <li key={i.supplier_id}>{i.supplier_name}
            <span className={`small ${bidders.has(i.supplier_id) ? 'good' : 'muted'}`}>{bidders.has(i.supplier_id) ? 'bidding' : 'no bid yet'}</span></li>
        ))}
      </ul>
      {all && (
        <div className="inline-confirm">
          {all.filter((s) => !invitedIds.has(s.id)).length === 0 ? <p className="muted small">All registered suppliers are already invited.</p> : (
            <div className="checks">
              {all.filter((s) => !invitedIds.has(s.id)).map((s) => (
                <label key={s.id} className={`check ${picked.includes(s.id) ? 'selected' : ''}`}>
                  <input type="checkbox" checked={picked.includes(s.id)}
                    onChange={() => setPicked((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]))} />
                  {s.name}
                </label>
              ))}
            </div>
          )}
          <div className="actions">
            <button className="btn" onClick={() => { setAll(null); setPicked([]); }}>Close</button>
            <button className="btn btn-primary" disabled={!picked.length} onClick={submit}>Invite {picked.length || ''}</button>
          </div>
        </div>
      )}
      <ErrorText error={error} />
    </div>
  );
}

// ---------- page ----------

export default function BuyerAuction({ rfq, status, now, reload }) {
  const ended = status === 'CLOSED' || status === 'FORCE_CLOSED';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{rfq.name} <StatusBadge status={status} /></h1>
          <p className="muted">{rfq.reference_id} · {rfq.currency} · Pickup {date(rfq.pickup_date)}</p>
        </div>
        <Clock rfq={rfq} status={status} now={now} />
      </div>

      {status === 'CANCELLED' && <div className="card banner banner-danger"><strong>Cancelled</strong> on {dateTime(rfq.cancelled_at)} — {rfq.cancel_reason}</div>}
      {status === 'PAUSED' && <div className="card banner banner-warn">Bidding is paused. When you resume, the close and forced close times move forward by the paused duration.</div>}
      {status === 'AWARDED' && <AwardResult rfq={rfq} />}
      {ended && <AwardPanel rfq={rfq} reload={reload} />}
      <Actions rfq={rfq} status={status} reload={reload} />

      <div className="stats">
        <div className="stat"><span className="label">Lowest bid (L1)</span><strong>{money(rfq.lowest_bid_minor, rfq.currency)}</strong></div>
        <div className="stat"><span className="label">Current bid close</span><strong>{dateTime(rfq.current_close_at)}</strong>
          {rfq.extension_count > 0 && <span className="small muted">{rfq.extension_count} extension(s)</span>}</div>
        <div className="stat"><span className="label">Forced close</span><strong>{dateTime(rfq.forced_close_at)}</strong></div>
        <div className="stat"><span className="label">Original close</span><strong>{dateTime(rfq.bid_close_at)}</strong></div>
      </div>
      <Timeline rfq={rfq} now={now} />

      <div className="layout-2">
        <div className="col">
          <Metrics rfq={rfq} />
          <Ranking rfq={rfq} />
          <div className="card"><h2>Auction configuration</h2><ConfigSummary rfq={rfq} /></div>
          <Invitations rfq={rfq} status={status} reload={reload} />
          <div className="card">
            <h2>All bids <span className="muted small">({rfq.bid_history.length})</span></h2>
            {rfq.bid_history.length === 0 ? <p className="muted">No bids yet.</p> : (
              <div className="table-wrap">
                <table className="table compact">
                  <thead><tr><th>Time</th><th>Supplier</th><th className="num">Freight</th><th className="num">Origin</th><th className="num">Dest.</th><th className="num">Total</th></tr></thead>
                  <tbody>
                    {[...rfq.bid_history].sort((a, b) => a.total_minor - b.total_minor || a.created_at - b.created_at).map((b) => (
                      <tr key={b.id}>
                        <td className="small">{dateTime(b.created_at)}</td>
                        <td>{b.supplier_name}</td>
                        <td className="num">{money(b.freight_charges_minor, rfq.currency)}</td>
                        <td className="num">{money(b.origin_charges_minor, rfq.currency)}</td>
                        <td className="num">{money(b.destination_charges_minor, rfq.currency)}</td>
                        <td className="num strong">{money(b.total_minor, rfq.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
        <ActivityLog activity={rfq.activity} />
      </div>
    </>
  );
}
