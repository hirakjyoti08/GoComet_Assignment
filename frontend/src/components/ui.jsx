import { dateTime, countdown, STATUS_LABEL, TRIGGER_LABEL, VISIBILITY_LABEL, decrementLabel } from '../format.js';

export function StatusBadge({ status }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>;
}

export function Field({ label, error, hint, children }) {
  return (
    <label className={`field ${error ? 'has-error' : ''}`}>
      <span className="label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

/** Big countdown box in the details header. Amber when inside the trigger window. */
export function Clock({ rfq, status, now }) {
  const inWindow = status === 'ACTIVE' && rfq.current_close_at - now <= rfq.trigger_window_minutes * 60_000;
  let label = null;
  let value = null;
  if (status === 'ACTIVE') { label = 'Closes in'; value = countdown(rfq.current_close_at - now); }
  else if (status === 'UPCOMING') { label = 'Opens in'; value = countdown(rfq.bid_start_at - now); }
  else if (status === 'PAUSED') { label = 'Paused — time remaining'; value = countdown(rfq.current_close_at - rfq.paused_at); }
  return (
    <div className={`clock ${inWindow ? 'clock-hot' : ''} ${status === 'PAUSED' ? 'clock-paused' : ''}`}>
      {value ? <><span className="small">{label}</span><strong>{value}</strong>{inWindow && <span className="small">In trigger window</span>}</>
        : <><span className="small">{STATUS_LABEL[status]}</span>
          <strong className="small-strong">{dateTime(rfq.cancelled_at || rfq.awarded_at || rfq.current_close_at)}</strong></>}
    </div>
  );
}

/** Progress from start to forced close with markers for original and current close. */
export function Timeline({ rfq, now }) {
  const start = rfq.bid_start_at;
  const end = rfq.forced_close_at;
  const pct = (t) => `${Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100))}%`;
  const effectiveNow = rfq.paused_at ?? now;
  return (
    <div className="timeline" aria-hidden="true">
      <div className="tl-track">
        <div className="tl-fill" style={{ width: pct(Math.min(effectiveNow, rfq.current_close_at)) }} />
        <div className="tl-mark tl-orig" style={{ left: pct(rfq.bid_close_at + (rfq.total_paused_ms || 0)) }} title="Original close" />
        <div className="tl-mark tl-close" style={{ left: pct(rfq.current_close_at) }} title="Current close" />
      </div>
      <div className="tl-labels small muted">
        <span>Start {dateTime(start)}</span>
        <span>Forced close {dateTime(end)}</span>
      </div>
    </div>
  );
}

export function ConfigSummary({ rfq }) {
  return (
    <dl className="config">
      <div><dt>Trigger window (X)</dt><dd>{rfq.trigger_window_minutes} min</dd></div>
      <div><dt>Extension (Y)</dt><dd>{rfq.extension_minutes} min</dd></div>
      <div><dt>Trigger</dt><dd>{TRIGGER_LABEL[rfq.trigger_type]}</dd></div>
      <div><dt>Min. decrement</dt><dd>{decrementLabel(rfq)}</dd></div>
      <div><dt>Supplier visibility</dt><dd>{VISIBILITY_LABEL[rfq.supplier_visibility]}</dd></div>
      <div><dt>Currency</dt><dd>{rfq.currency}</dd></div>
    </dl>
  );
}

// Short ledger codes instead of pictograms, like entries in a shipping log.
const LOG_CODE = {
  RFQ_CREATED: 'New', RFQ_UPDATED: 'Edit', SUPPLIER_INVITED: 'Inv', AUCTION_STARTED: 'Open', BID_SUBMITTED: 'Bid',
  TIME_EXTENDED: 'Ext', EXTENSION_CAPPED: 'Cap', AUCTION_PAUSED: 'Hold', AUCTION_RESUMED: 'Run', AUCTION_CLOSED: 'Shut',
  AUCTION_FORCE_CLOSED: 'Stop', AUCTION_CANCELLED: 'Void', RFQ_AWARDED: 'Won',
};

export function ActivityLog({ activity }) {
  return (
    <aside className="card activity">
      <h2>Activity log</h2>
      {activity.length === 0 ? <p className="muted">No activity yet.</p> : (
        <ol className="log">
          {activity.map((a) => (
            <li key={a.id} className={`log-${a.type.toLowerCase()}`}>
              <span className="log-icon" aria-hidden="true">{LOG_CODE[a.type] || 'Note'}</span>
              <div>
                <div className="small muted">{dateTime(a.created_at)}</div>
                <div>{a.message}</div>
                {a.type === 'TIME_EXTENDED' && a.metadata && (
                  <div className="small reason">
                    {dateTime(a.metadata.from)} → {dateTime(a.metadata.to)}{a.metadata.capped ? ' (capped at forced close)' : ''}
                    <br />Reason: {a.metadata.reason}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

export function ErrorText({ error }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}
