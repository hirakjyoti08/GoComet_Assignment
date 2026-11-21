import { useState } from 'react';
import { money, dateTime, date, decrementLabel, inputToMinor, nextBidCeiling } from '../format.js';
import { api, newIdempotencyKey } from '../api.js';
import { StatusBadge, Clock, Timeline, ConfigSummary, ActivityLog, Field, ErrorText } from '../components/ui.jsx';

/** The supplier's own standing. Competitor names/prices are never sent by the server. */
export function Position({ rfq }) {
  const gap = rfq.l1_visible && rfq.my_best && rfq.l1_total_minor != null && !rfq.i_am_l1
    ? rfq.my_best.total_minor - rfq.l1_total_minor : null;
  return (
    <div className="position card">
      <div className="pos-rank">
        <span className="label">Your rank</span>
        {rfq.my_rank ? <strong className={`big-rank rank-${Math.min(rfq.my_rank, 3)}`}>L{rfq.my_rank}</strong> : <strong className="muted">—</strong>}
        <span className="small muted">{rfq.my_rank ? `of ${rfq.competitor_count + 1} bidding suppliers` : `${rfq.competitor_count} supplier(s) bidding`}</span>
      </div>
      <div><span className="label">Your best bid</span><strong>{money(rfq.my_best?.total_minor, rfq.currency)}</strong></div>
      <div><span className="label">Lowest bid (L1)</span>
        <strong>{rfq.l1_visible ? money(rfq.l1_total_minor, rfq.currency) : <span className="muted small">hidden by buyer</span>}</strong>
        {gap != null && gap > 0 && <span className="small muted">you are {money(gap, rfq.currency)} above L1</span>}
        {rfq.i_am_l1 && <span className="small good">You are the lowest bidder</span>}</div>
      <div><span className="label">Minimum decrement</span><strong>{decrementLabel(rfq)}</strong></div>
    </div>
  );
}

export function BidForm({ rfq, onPlaced }) {
  const validity = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const last = rfq.my_bids[0];
  const [form, setForm] = useState({
    carrierName: last?.carrier_name ?? '', freightCharges: '', originCharges: last ? String(last.origin_charges_minor / 100) : '0',
    destinationCharges: last ? String(last.destination_charges_minor / 100) : '0',
    transitTimeDays: last ? String(last.transit_time_days) : '', quoteValidUntil: last?.quote_valid_until ?? validity,
  });
  const [errors, setErrors] = useState({});
  const [msg, setMsg] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // One key per reviewed bid. A retry of the same bid (e.g. after a network error) reuses it, so the
  // server can never record it twice; editing the form starts a new bid with a new key.
  const [bidKey, setBidKey] = useState(null);
  const set = (k) => (e) => { setConfirming(false); setBidKey(null); setForm((f) => ({ ...f, [k]: e.target.value })); };
  const total = inputToMinor(form.freightCharges) + inputToMinor(form.originCharges) + inputToMinor(form.destinationCharges);
  const ceiling = nextBidCeiling(rfq); // client-side preview; the server enforces it for real

  function review(e) {
    e.preventDefault();
    setMsg(null);
    const errs = {};
    if (!form.carrierName.trim()) errs.carrierName = 'Carrier name is required';
    if (!(total > 0)) errs.freightCharges = 'Enter your charges';
    if (!(Number(form.transitTimeDays) >= 1)) errs.transitTimeDays = 'Required';
    setErrors(errs);
    if (!Object.keys(errs).length) { setBidKey((k) => k ?? newIdempotencyKey()); setConfirming(true); }
  }

  async function submit() {
    setBusy(true); setMsg(null); setErrors({});
    try {
      const res = await api.submitBid(rfq.id, form, bidKey);
      setMsg({ ok: true, text: `Bid placed — you are L${res.rank} at ${money(res.totalMinor, rfq.currency)}.` +
        (res.extension ? ` Auction extended to ${dateTime(res.extension.to)}.` : '') });
      setForm((f) => ({ ...f, freightCharges: '' }));
      setBidKey(null);
      setConfirming(false);
      onPlaced();
    } catch (err) {
      setErrors(err.details || {});
      setMsg({ ok: false, text: err.message });
      // Network failure: keep the confirm step (and the same key) so "Confirm bid" safely retries.
      if (err.status !== 0) { setConfirming(false); setBidKey(null); }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={review} noValidate>
      <h2>{rfq.my_best ? 'Improve your quote' : 'Submit your quote'}</h2>
      {ceiling != null && <p className="hint">Your next bid must be <b>{money(ceiling, rfq.currency)}</b> or lower.</p>}
      <div className="grid-2">
        <Field label="Carrier name" error={errors.carrierName}><input value={form.carrierName} onChange={set('carrierName')} /></Field>
        <Field label="Transit time (days)" error={errors.transitTimeDays}>
          <input type="number" min="1" value={form.transitTimeDays} onChange={set('transitTimeDays')} />
        </Field>
        <Field label={`Freight charges (${rfq.currency})`} error={errors.freightCharges}>
          <input inputMode="decimal" value={form.freightCharges} onChange={set('freightCharges')} />
        </Field>
        <Field label={`Origin charges (${rfq.currency})`} error={errors.originCharges}>
          <input inputMode="decimal" value={form.originCharges} onChange={set('originCharges')} />
        </Field>
        <Field label={`Destination charges (${rfq.currency})`} error={errors.destinationCharges}>
          <input inputMode="decimal" value={form.destinationCharges} onChange={set('destinationCharges')} />
        </Field>
        <Field label="Quote valid until" error={errors.quoteValidUntil}>
          <input type="date" value={form.quoteValidUntil} onChange={set('quoteValidUntil')} />
        </Field>
      </div>
      <div className="total-row">
        <span className="label">Total quote</span>
        <span className={`total ${ceiling != null && total > ceiling ? 'over' : ''}`}>{money(total, rfq.currency)}</span>
      </div>
      {msg && <p className={msg.ok ? 'success' : 'error'} role="status">{msg.text}</p>}
      {confirming ? (
        <div className="inline-confirm">
          <p>Submit a bid of <b>{money(total, rfq.currency)}</b>? Bids cannot be withdrawn.</p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setConfirming(false)}>Back</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Submitting…' : 'Confirm bid'}</button>
          </div>
        </div>
      ) : (
        <div className="actions"><button className="btn btn-primary">Review bid</button></div>
      )}
    </form>
  );
}

export default function SupplierAuction({ rfq, status, now, reload }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{rfq.name} <StatusBadge status={status} /></h1>
          <p className="muted">{rfq.reference_id} · {rfq.currency} · Pickup {date(rfq.pickup_date)}</p>
        </div>
        <Clock rfq={rfq} status={status} now={now} />
      </div>

      {status === 'CANCELLED' && <div className="card banner banner-danger"><strong>This RFQ was cancelled by the buyer</strong> — {rfq.cancel_reason}</div>}
      {status === 'PAUSED' && <div className="card banner banner-warn">The buyer has paused bidding. The remaining time is frozen and will resume where it left off.</div>}
      {rfq.award && (rfq.award.awarded_to_me
        ? <div className="card banner banner-success"><strong>Congratulations — you won this RFQ.</strong> The buyer will contact you with next steps.</div>
        : <div className="card banner">This RFQ was awarded to another supplier.</div>)}

      <Position rfq={rfq} />
      <Timeline rfq={rfq} now={now} />

      <div className="layout-2">
        <div className="col">
          {status === 'ACTIVE' ? <BidForm rfq={rfq} onPlaced={reload} /> : (
            <div className="card muted">
              {status === 'UPCOMING' ? `Bidding opens ${dateTime(rfq.bid_start_at)}.`
                : status === 'PAUSED' ? 'Bidding will reopen when the buyer resumes the auction.'
                  : 'This auction is closed. No more bids are accepted.'}
            </div>
          )}
          <div className="card">
            <h2>Your bids <span className="muted small">({rfq.my_bids.length})</span></h2>
            {rfq.my_bids.length === 0 ? <p className="muted">You haven't bid yet.</p> : (
              <div className="table-wrap">
                <table className="table compact">
                  <thead><tr><th>Time</th><th className="num">Freight</th><th className="num">Origin</th><th className="num">Dest.</th><th className="num">Total</th><th className="num">Transit</th></tr></thead>
                  <tbody>
                    {rfq.my_bids.map((b) => (
                      <tr key={b.id}>
                        <td className="small">{dateTime(b.created_at)}</td>
                        <td className="num">{money(b.freight_charges_minor, rfq.currency)}</td>
                        <td className="num">{money(b.origin_charges_minor, rfq.currency)}</td>
                        <td className="num">{money(b.destination_charges_minor, rfq.currency)}</td>
                        <td className="num strong">{money(b.total_minor, rfq.currency)}</td>
                        <td className="num">{b.transit_time_days} d</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card"><h2>Auction rules</h2><ConfigSummary rfq={rfq} />
            <p className="small muted">Current close {dateTime(rfq.current_close_at)} · Forced close {dateTime(rfq.forced_close_at)}</p></div>
        </div>
        <ActivityLog activity={rfq.activity} />
      </div>
    </>
  );
}
