import { Link, useNavigate } from 'react-router-dom';
import { api, useLiveData, useNow } from '../api.js';
import { useAuth } from '../auth.jsx';
import { money, dateTime, countdown, liveStatus } from '../format.js';
import { StatusBadge } from '../components/ui.jsx';

function CloseCell({ r, status, now }) {
  return (
    <td>
      {dateTime(r.current_close_at)}
      {r.extension_count > 0 && <span className="chip" title="Times extended">+{r.extension_count} ext</span>}
      {status === 'ACTIVE' && <div className="small countdown">closes in {countdown(r.current_close_at - now)}</div>}
      {status === 'UPCOMING' && <div className="small muted">opens in {countdown(r.bid_start_at - now)}</div>}
      {status === 'PAUSED' && <div className="small muted">paused</div>}
    </td>
  );
}

function RfqCell({ r }) {
  return (
    <td>
      <Link to={`/rfqs/${r.id}`} className="strong" onClick={(e) => e.stopPropagation()}>{r.name}</Link>
      <div className="muted small">{r.reference_id} · {r.currency}</div>
    </td>
  );
}

export default function AuctionList() {
  const { user } = useAuth();
  const isBuyer = user.role === 'BUYER';
  const { data, error, loading } = useLiveData(api.listRfqs, null);
  const now = useNow();
  const navigate = useNavigate();

  if (loading) return <p className="muted">Loading auctions…</p>;
  if (error) return <p className="error">Could not load auctions: {error.message}</p>;
  const rfqs = data.rfqs;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{isBuyer ? 'Your British Auctions' : 'Auctions you are invited to'}</h1>
          <p className="muted">Live updates — closing times move automatically when late activity triggers an extension.</p>
        </div>
      </div>

      {rfqs.length === 0 ? (
        <div className="empty card">
          {isBuyer ? <>
            <p>No RFQs yet.</p>
            <Link to="/rfqs/new" className="btn btn-primary">Create your first RFQ</Link>
          </> : <p>You haven't been invited to any auctions yet. Buyers will invite you by your company name.</p>}
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              {isBuyer ? (
                <tr><th>RFQ</th><th className="num">Current lowest bid</th><th>Current bid close</th><th>Forced close</th><th>Status</th><th className="num">Bids</th></tr>
              ) : (
                <tr><th>RFQ</th><th className="num">Your rank</th><th className="num">Your best bid</th><th className="num">L1 price</th><th>Current bid close</th><th>Forced close</th><th>Status</th></tr>
              )}
            </thead>
            <tbody>
              {rfqs.map((r) => {
                const status = liveStatus(r, now);
                return (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/rfqs/${r.id}`)}>
                    <RfqCell r={r} />
                    {isBuyer ? <>
                      <td className="num strong">{money(r.lowest_bid_minor, r.currency)}</td>
                      <CloseCell r={r} status={status} now={now} />
                      <td>{dateTime(r.forced_close_at)}</td>
                      <td><StatusBadge status={status} /></td>
                      <td className="num">{r.bid_count}<div className="muted small">{r.supplier_count}/{r.invited_count} suppliers</div></td>
                    </> : <>
                      <td className="num">{r.my_rank ? <span className={`rank rank-${Math.min(r.my_rank, 3)}`}>L{r.my_rank}</span> : <span className="muted">—</span>}
                        <div className="muted small">of {r.competitor_count + (r.my_rank ? 1 : 0)}</div></td>
                      <td className="num strong">{money(r.my_best?.total_minor, r.currency)}</td>
                      <td className="num">{r.l1_visible ? money(r.l1_total_minor, r.currency) : <span className="muted small">hidden</span>}</td>
                      <CloseCell r={r} status={status} now={now} />
                      <td>{dateTime(r.forced_close_at)}</td>
                      <td><StatusBadge status={status} />
                        {r.awarded_to_me === true && <div className="small win">Awarded to you</div>}</td>
                    </>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
