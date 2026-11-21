import { Link, useParams } from 'react-router-dom';
import { api, useLiveData, useNow } from '../api.js';
import { useAuth } from '../auth.jsx';
import { liveStatus } from '../format.js';
import BuyerAuction from './BuyerAuction.jsx';
import SupplierAuction from './SupplierAuction.jsx';

/** Loads the RFQ (live) and renders the view for the signed-in role. The server already shaped the data per role. */
export default function AuctionDetails() {
  const { id } = useParams();
  const { user } = useAuth();
  const { data, error, loading, reload } = useLiveData(() => api.getRfq(id), id);
  const now = useNow();

  if (loading) return <p className="muted">Loading auction…</p>;
  if (error && !data) return <p className="error">{error.message}. <Link to="/">Back to auctions</Link></p>;
  const rfq = data.rfq;
  const status = liveStatus(rfq, now);
  const props = { rfq, status, now, reload };

  return (
    <section>
      <Link to="/" className="back">← All auctions</Link>
      {user.role === 'BUYER' ? <BuyerAuction {...props} /> : <SupplierAuction {...props} />}
    </section>
  );
}
