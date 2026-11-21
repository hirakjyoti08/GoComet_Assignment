// Role-specific projections. The supplier view is built on the server so competitor
// names and prices never leave the backend unless the RFQ's visibility setting allows it.

const BASE_FIELDS = [
  'id', 'reference_id', 'name', 'pickup_date', 'currency', 'bid_start_at', 'bid_close_at', 'current_close_at',
  'forced_close_at', 'status', 'extension_count', 'paused_at', 'total_paused_ms', 'cancelled_at', 'cancel_reason',
  'awarded_at', 'closed_at', 'created_at', 'updated_at', 'trigger_window_minutes', 'extension_minutes', 'trigger_type',
  'min_decrement_type', 'min_decrement_value', 'supplier_visibility',
];

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));

const publicBid = (b) => b && ({
  id: b.id, supplier_id: b.supplier_id, supplier_name: b.supplier_name, carrier_name: b.carrier_name,
  freight_charges_minor: b.freight_charges_minor, origin_charges_minor: b.origin_charges_minor,
  destination_charges_minor: b.destination_charges_minor, total_minor: b.total_minor,
  transit_time_days: b.transit_time_days, quote_valid_until: b.quote_valid_until, created_at: b.created_at,
  ...(b.rank ? { rank: b.rank } : {}),
});

// JSONB comes back already parsed from PostgreSQL; accept a string too for safety.
const parseMeta = (l) => (l.metadata == null ? null : typeof l.metadata === 'string' ? JSON.parse(l.metadata) : l.metadata);

// ---------- buyer ----------

export function buyerDetailView({ rfq, ranking, bids, invitations, activity, metrics }) {
  const awardedBid = rfq.awarded_bid_id ? bids.find((b) => b.id === rfq.awarded_bid_id) : null;
  return {
    ...pick(rfq, BASE_FIELDS),
    viewer_role: 'BUYER',
    lowest_bid_minor: ranking[0]?.total_minor ?? null,
    ranking: ranking.map(publicBid),
    bid_history: [...bids].reverse().map(publicBid),
    invitations,
    metrics,
    award: rfq.awarded_at ? {
      supplier_id: rfq.awarded_supplier_id, supplier_name: awardedBid?.supplier_name, bid: publicBid(awardedBid),
      reason: rfq.award_reason, awarded_at: rfq.awarded_at,
      was_l1: ranking[0]?.supplier_id === rfq.awarded_supplier_id,
    } : null,
    activity: activity.map((l) => ({ id: l.id, type: l.type, message: l.message, metadata: parseMeta(l), created_at: l.created_at })),
  };
}

export function buyerListItem(rfq) {
  return {
    ...pick(rfq, BASE_FIELDS),
    lowest_bid_minor: rfq.lowest_bid_minor ?? null,
    bid_count: rfq.bid_count, supplier_count: rfq.supplier_count, invited_count: rfq.invited_count,
  };
}

// ---------- supplier ----------

function supplierPosition(rfq, ranking, supplierId) {
  const mine = ranking.find((r) => r.supplier_id === supplierId) || null;
  const showL1 = rfq.supplier_visibility === 'RANK_AND_L1_PRICE';
  return {
    my_rank: mine?.rank ?? null,
    my_best: publicBid(mine),
    competitor_count: ranking.filter((r) => r.supplier_id !== supplierId).length,
    l1_total_minor: showL1 ? ranking[0]?.total_minor ?? null : null,
    l1_visible: showL1,
    i_am_l1: !!mine && mine.rank === 1,
  };
}

/** Rewrites the activity log so a supplier only learns about their own bids and auction-level events. */
export function redactActivityForSupplier(activity, supplierId) {
  const out = [];
  for (const l of activity) {
    const meta = parseMeta(l);
    const own = l.supplier_id === supplierId;
    let message = l.message;
    let metadata = null;
    switch (l.type) {
      case 'BID_SUBMITTED':
        message = own ? `You bid ${meta.totalFormatted} — you were L${meta.rank} at that point` : 'A competitor submitted a bid';
        break;
      case 'SUPPLIER_INVITED':
        if (!own) continue;
        message = 'You were invited to this RFQ';
        break;
      case 'RFQ_AWARDED':
        message = own ? 'Congratulations — this RFQ was awarded to you' : 'This RFQ was awarded to another supplier';
        break;
      case 'RFQ_CREATED':
        message = 'RFQ published';
        break;
      case 'TIME_EXTENDED':
        metadata = { from: meta.from, to: meta.to, capped: meta.capped, reason: meta.reason };
        break;
      default:
        break;
    }
    out.push({ id: l.id, type: l.type, message, metadata, created_at: l.created_at });
  }
  return out;
}

export function supplierDetailView({ rfq, ranking, bids, activity, supplierId }) {
  return {
    ...pick(rfq, BASE_FIELDS),
    viewer_role: 'SUPPLIER',
    ...supplierPosition(rfq, ranking, supplierId),
    my_bids: bids.filter((b) => b.supplier_id === supplierId).reverse().map(publicBid),
    award: rfq.awarded_at ? { awarded_to_me: rfq.awarded_supplier_id === supplierId, awarded_at: rfq.awarded_at } : null,
    activity: redactActivityForSupplier(activity, supplierId),
  };
}

export function supplierListItem(rfq, ranking, supplierId) {
  return {
    ...pick(rfq, BASE_FIELDS),
    ...supplierPosition(rfq, ranking, supplierId),
    awarded_to_me: rfq.awarded_at ? rfq.awarded_supplier_id === supplierId : null,
  };
}
