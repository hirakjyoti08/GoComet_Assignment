import { createHash } from 'node:crypto';
import {
  AppError, MIN, computeStatus, isEnded, rankBids, evaluateTrigger, computeExtension,
  checkBidAllowed, computeRfqMetrics, formatMinor,
} from './rules.js';
import { validateRfq, validateBid } from './validation.js';
import { buyerDetailView, buyerListItem, supplierDetailView, supplierListItem } from './views.js';

export { AppError, TRIGGER_TYPES, computeStatus, rankBids, evaluateTrigger, computeExtension } from './rules.js';

const fmtDuration = (ms) => {
  const m = Math.floor(ms / MIN);
  const s = Math.round((ms % MIN) / 1000);
  return m ? `${m} min ${s} s` : `${s} s`;
};

const RFQ_COLUMNS = `r.*, c.trigger_window_minutes, c.extension_minutes, c.trigger_type,
  c.min_decrement_type, c.min_decrement_value, c.supplier_visibility`;
const RFQ_FROM = 'FROM rfqs r JOIN auction_configs c ON c.rfq_id = r.id';
const BID_SELECT = `SELECT b.*, s.name AS supplier_name FROM bids b JOIN suppliers s ON s.id = b.supplier_id`;

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;
const groupBy = (rows, key) => rows.reduce((m, r) => m.set(r[key], [...(m.get(r[key]) || []), r]), new Map());

/**
 * All business operations. Every method is async, takes the signed-in user (actor) and an
 * injectable `now` (tests and the seed pass fake clocks), and runs writes in a transaction that
 * first locks the RFQ row (SELECT … FOR UPDATE). Concurrent bids on the same auction therefore
 * execute one after another — on any number of app instances — while bids on different auctions
 * proceed in parallel.
 */
export function createAuctionService(db, { onChange = () => {} } = {}) {
  // ---------- query helpers (take q = db.query or a transaction's q) ----------

  const getRfqRow = async (q, id, { lock = false } = {}) =>
    (await q(`SELECT ${RFQ_COLUMNS} ${RFQ_FROM} WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`, [id])).rows[0] ?? null;
  const getBids = async (q, rfqId) => (await q(`${BID_SELECT} WHERE b.rfq_id = $1 ORDER BY b.created_at, b.id`, [rfqId])).rows;
  const isInvited = async (q, rfqId, supplierId) =>
    (await q('SELECT 1 FROM rfq_invitations WHERE rfq_id = $1 AND supplier_id = $2', [rfqId, supplierId])).rowCount > 0;

  const log = (q, rfqId, type, message, { supplierId = null, actorId = null, metadata = null } = {}, at) =>
    q(`INSERT INTO activity_logs (rfq_id, type, message, supplier_id, actor_user_id, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [rfqId, type, message, supplierId, actorId, metadata ? JSON.stringify(metadata) : null, at]);

  /** Buyers may only touch their own RFQs; suppliers only RFQs they're invited to. Anything else → 404. */
  async function loadForActor(q, actor, id, opts) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(404, 'RFQ not found');
    const rfq = await getRfqRow(q, id, opts);
    const allowed = rfq && (actor.role === 'BUYER' ? rfq.buyer_id === actor.id : await isInvited(q, id, actor.supplier_id));
    if (!allowed) throw new AppError(404, 'RFQ not found');
    return rfq;
  }
  async function loadOwned(q, actor, id) {
    if (actor.role !== 'BUYER') throw new AppError(403, 'Only buyers can do this');
    return loadForActor(q, actor, id, { lock: true });
  }

  async function assertSuppliersExist(q, ids) {
    const { rows } = await q('SELECT id FROM suppliers WHERE id = ANY($1::bigint[])', [ids]);
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((i) => !found.has(i));
    if (missing.length) throw new AppError(400, 'Validation failed', { invitedSupplierIds: `Unknown supplier id(s): ${missing.join(', ')}` });
  }

  async function inviteAll(q, rfqId, supplierIds, actorId, now) {
    const { rows } = await q(`INSERT INTO rfq_invitations (rfq_id, supplier_id, invited_at)
      SELECT $1, unnest($2::bigint[]), $3 ON CONFLICT DO NOTHING RETURNING supplier_id`, [rfqId, supplierIds, now]);
    if (rows.length) {
      const names = (await q('SELECT id, name FROM suppliers WHERE id = ANY($1::bigint[])', [rows.map((r) => r.supplier_id)])).rows;
      for (const s of names) await log(q, rfqId, 'SUPPLIER_INVITED', `${s.name} invited`, { supplierId: s.id, actorId }, now);
    }
    return rows.length;
  }

  /**
   * Idempotency: if the client sends an Idempotency-Key, the first request's result is stored in the same
   * transaction as the work itself. A retry with the same key (network blip, double click, proxy retry)
   * gets the stored result back instead of creating a second bid. Same key + different body → 422.
   */
  async function idempotent(q, actor, key, scope, input, fn) {
    if (!key) return fn();
    if (!IDEMPOTENCY_KEY_RE.test(key)) throw new AppError(400, 'Idempotency-Key must be 8–100 characters of A–Z, a–z, 0–9, _ or -');
    const hash = createHash('sha256').update(`${scope}|${JSON.stringify(input)}`).digest('hex');
    const ins = await q(`INSERT INTO idempotency_keys (user_id, key, scope, request_hash, created_at)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [actor.id, key, scope, hash, Date.now()]);
    if (ins.rowCount === 0) {
      const prev = (await q('SELECT scope, request_hash, response FROM idempotency_keys WHERE user_id = $1 AND key = $2', [actor.id, key])).rows[0];
      if (prev.scope !== scope || prev.request_hash !== hash) {
        throw new AppError(422, 'This Idempotency-Key was already used for a different request');
      }
      return { ...prev.response, replayed: true };
    }
    const result = await fn();
    await q('UPDATE idempotency_keys SET status_code = 201, response = $3::jsonb WHERE user_id = $1 AND key = $2',
      [actor.id, key, JSON.stringify(result)]);
    return result;
  }

  // ---------- reads ----------

  const listSuppliers = async () => (await db.query('SELECT id, name FROM suppliers ORDER BY lower(name)')).rows;

  async function listRfqs(actor, now = Date.now()) {
    if (actor.role === 'BUYER') {
      const { rows } = await db.query(`SELECT ${RFQ_COLUMNS},
          (SELECT MIN(total_minor) FROM bids b WHERE b.rfq_id = r.id) AS lowest_bid_minor,
          (SELECT COUNT(*) FROM bids b WHERE b.rfq_id = r.id) AS bid_count,
          (SELECT COUNT(DISTINCT supplier_id) FROM bids b WHERE b.rfq_id = r.id) AS supplier_count,
          (SELECT COUNT(*) FROM rfq_invitations i WHERE i.rfq_id = r.id) AS invited_count
        ${RFQ_FROM} WHERE r.buyer_id = $1 ORDER BY r.created_at DESC`, [actor.id]);
      return rows.map((r) => buyerListItem({ ...r, status: computeStatus(r, now) }));
    }
    const { rows } = await db.query(`SELECT ${RFQ_COLUMNS} ${RFQ_FROM} JOIN rfq_invitations i ON i.rfq_id = r.id
      WHERE i.supplier_id = $1 ORDER BY r.bid_start_at DESC`, [actor.supplier_id]);
    if (!rows.length) return [];
    // One query for all bids instead of one per RFQ.
    const bids = groupBy((await db.query(`${BID_SELECT} WHERE b.rfq_id = ANY($1::bigint[]) ORDER BY b.created_at, b.id`,
      [rows.map((r) => r.id)])).rows, 'rfq_id');
    return rows.map((r) => supplierListItem({ ...r, status: computeStatus(r, now) }, rankBids(bids.get(r.id) || []), actor.supplier_id));
  }

  async function getRfq(actor, id, now = Date.now()) {
    const q = db.query;
    const raw = await loadForActor(q, actor, id);
    const rfq = { ...raw, status: computeStatus(raw, now) };
    const [bids, activity] = await Promise.all([
      getBids(q, id),
      q('SELECT * FROM activity_logs WHERE rfq_id = $1 ORDER BY created_at DESC, id DESC', [id]).then((r) => r.rows),
    ]);
    const ranking = rankBids(bids);
    if (actor.role === 'SUPPLIER') return supplierDetailView({ rfq, ranking, bids, activity, supplierId: actor.supplier_id });
    const invitations = (await q(`SELECT s.id AS supplier_id, s.name AS supplier_name, i.invited_at FROM rfq_invitations i
      JOIN suppliers s ON s.id = i.supplier_id WHERE i.rfq_id = $1 ORDER BY lower(s.name)`, [id])).rows;
    const metrics = computeRfqMetrics({ bids, extensionCount: rfq.extension_count, invitedCount: invitations.length });
    return buyerDetailView({ rfq, ranking, bids, invitations, activity, metrics });
  }

  // ---------- buyer actions ----------

  async function createRfq(actor, input, now = Date.now(), { idempotencyKey } = {}) {
    if (actor.role !== 'BUYER') throw new AppError(403, 'Only buyers can create RFQs');
    const d = validateRfq(input);
    let result;
    try {
      result = await db.tx((q) => idempotent(q, actor, idempotencyKey, 'rfq:create', input, async () => {
        await assertSuppliersExist(q, d.supplierIds);
        const { rows } = await q(`INSERT INTO rfqs (buyer_id, reference_id, name, pickup_date, currency, bid_start_at, bid_close_at,
          current_close_at, forced_close_at, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,'UPCOMING',$9,$9) RETURNING id`,
        [actor.id, d.referenceId, d.name, d.pickupDate, d.currency, d.start, d.close, d.forced, now]);
        const rfqId = rows[0].id;
        await q(`INSERT INTO auction_configs (rfq_id, trigger_window_minutes, extension_minutes, trigger_type,
          min_decrement_type, min_decrement_value, supplier_visibility) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [rfqId, d.triggerWindowMinutes, d.extensionMinutes, d.triggerType, d.minDecrementType, d.minDecrementValue, d.supplierVisibility]);
        await log(q, rfqId, 'RFQ_CREATED', 'RFQ created with British Auction enabled', {
          actorId: actor.id,
          metadata: { triggerWindowMinutes: d.triggerWindowMinutes, extensionMinutes: d.extensionMinutes, triggerType: d.triggerType },
        }, now);
        await inviteAll(q, rfqId, d.supplierIds, actor.id, now);
        return { id: rfqId };
      }));
    } catch (err) {
      if (err?.code === '23505' && String(err.constraint).includes('reference_id')) {
        throw new AppError(409, 'Validation failed', { referenceId: 'Reference ID already exists' });
      }
      throw err;
    }
    if (!result.replayed) { await syncStatuses(now); onChange(result.id); }
    return getRfq(actor, result.id, now);
  }

  /** Full edit is only allowed before bidding opens; after that the rules are locked. */
  async function updateRfq(actor, id, input, now = Date.now()) {
    const d = validateRfq(input);
    try {
      await db.tx(async (q) => {
        const rfq = await loadOwned(q, actor, id);
        if (computeStatus(rfq, now) !== 'UPCOMING') throw new AppError(409, 'An RFQ can only be edited before bidding opens');
        await assertSuppliersExist(q, d.supplierIds);
        await q(`UPDATE rfqs SET reference_id=$1, name=$2, pickup_date=$3, currency=$4, bid_start_at=$5, bid_close_at=$6,
          current_close_at=$6, forced_close_at=$7, updated_at=$8 WHERE id=$9`,
        [d.referenceId, d.name, d.pickupDate, d.currency, d.start, d.close, d.forced, now, id]);
        await q(`UPDATE auction_configs SET trigger_window_minutes=$1, extension_minutes=$2, trigger_type=$3, min_decrement_type=$4,
          min_decrement_value=$5, supplier_visibility=$6 WHERE rfq_id=$7`,
        [d.triggerWindowMinutes, d.extensionMinutes, d.triggerType, d.minDecrementType, d.minDecrementValue, d.supplierVisibility, id]);
        await q('DELETE FROM rfq_invitations WHERE rfq_id = $1', [id]);
        await q('INSERT INTO rfq_invitations (rfq_id, supplier_id, invited_at) SELECT $1, unnest($2::bigint[]), $3', [id, d.supplierIds, now]);
        await log(q, id, 'RFQ_UPDATED', 'RFQ details and auction rules updated', { actorId: actor.id }, now);
      });
    } catch (err) {
      if (err?.code === '23505' && String(err.constraint).includes('reference_id')) {
        throw new AppError(409, 'Validation failed', { referenceId: 'Reference ID already exists' });
      }
      throw err;
    }
    await syncStatuses(now);
    onChange(id);
    return getRfq(actor, id, now);
  }

  async function inviteSuppliers(actor, id, supplierIds, now = Date.now()) {
    const ids = Array.isArray(supplierIds) ? [...new Set(supplierIds.map(Number))] : [];
    if (!ids.length || ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
      throw new AppError(400, 'Validation failed', { supplierIds: 'Select at least one supplier' });
    }
    const added = await db.tx(async (q) => {
      const rfq = await loadOwned(q, actor, id);
      if (!['UPCOMING', 'ACTIVE', 'PAUSED'].includes(computeStatus(rfq, now))) {
        throw new AppError(409, 'Suppliers can only be invited before the auction ends');
      }
      await assertSuppliersExist(q, ids);
      return inviteAll(q, id, ids, actor.id, now);
    });
    onChange(id);
    return { added };
  }

  /**
   * Pause freezes the auction: bids are rejected and the countdown stops. On resume both the current close
   * and the forced close move forward by the paused duration, so the pause doesn't eat into bidding time.
   */
  async function pauseRfq(actor, id, now = Date.now()) {
    await db.tx(async (q) => {
      const rfq = await loadOwned(q, actor, id);
      if (computeStatus(rfq, now) !== 'ACTIVE') throw new AppError(409, 'Only an active auction can be paused');
      await q("UPDATE rfqs SET paused_at = $1, status = 'PAUSED', updated_at = $1 WHERE id = $2", [now, id]);
      await log(q, id, 'AUCTION_PAUSED', 'Auction paused by buyer — bidding is suspended', { actorId: actor.id }, now);
    });
    onChange(id);
    return getRfq(actor, id, now);
  }

  async function resumeRfq(actor, id, now = Date.now()) {
    await db.tx(async (q) => {
      const rfq = await loadOwned(q, actor, id);
      if (!rfq.paused_at || rfq.cancelled_at) throw new AppError(409, 'Auction is not paused');
      const shift = now - rfq.paused_at;
      await q(`UPDATE rfqs SET paused_at = NULL, current_close_at = current_close_at + $1, forced_close_at = forced_close_at + $1,
        total_paused_ms = total_paused_ms + $1, status = 'ACTIVE', updated_at = $2 WHERE id = $3`, [shift, now, id]);
      await log(q, id, 'AUCTION_RESUMED', `Auction resumed — close and forced close times shifted by ${fmtDuration(shift)}`, {
        actorId: actor.id,
        metadata: { pausedMs: shift, newCloseAt: rfq.current_close_at + shift, newForcedCloseAt: rfq.forced_close_at + shift },
      }, now);
    });
    await syncStatuses(now);
    onChange(id);
    return getRfq(actor, id, now);
  }

  async function cancelRfq(actor, id, reason, now = Date.now()) {
    if (typeof reason !== 'string' || reason.trim().length < 3) {
      throw new AppError(400, 'Validation failed', { reason: 'Please give a reason for cancelling' });
    }
    await db.tx(async (q) => {
      const rfq = await loadOwned(q, actor, id);
      const status = computeStatus(rfq, now);
      if (status === 'CANCELLED' || status === 'AWARDED') throw new AppError(409, `RFQ is already ${status.toLowerCase()}`);
      await q(`UPDATE rfqs SET cancelled_at = $1, cancel_reason = $2, paused_at = NULL, status = 'CANCELLED', updated_at = $1
        WHERE id = $3`, [now, reason.trim(), id]);
      await log(q, id, 'AUCTION_CANCELLED', `RFQ cancelled: ${reason.trim()}`, { actorId: actor.id }, now);
    });
    onChange(id);
    return getRfq(actor, id, now);
  }

  /** Award after close. Awarding someone other than L1 requires a justification. */
  async function awardRfq(actor, id, { supplierId, reason } = {}, now = Date.now()) {
    await db.tx(async (q) => {
      const rfq = await loadOwned(q, actor, id);
      if (!isEnded(computeStatus(rfq, now))) throw new AppError(409, 'An RFQ can only be awarded after the auction has closed');
      const ranking = rankBids(await getBids(q, id));
      const winner = ranking.find((r) => r.supplier_id === Number(supplierId));
      if (!winner) throw new AppError(400, 'Validation failed', { supplierId: 'Choose a supplier who submitted a bid' });
      const trimmed = typeof reason === 'string' ? reason.trim() : '';
      if (winner.rank !== 1 && trimmed.length < 5) {
        throw new AppError(400, 'Validation failed', { reason: 'A reason is required when awarding to a supplier other than L1' });
      }
      await q(`UPDATE rfqs SET awarded_supplier_id = $1, awarded_bid_id = $2, award_reason = $3, awarded_at = $4,
        status = 'AWARDED', updated_at = $4 WHERE id = $5`, [winner.supplier_id, winner.id, trimmed || null, now, id]);
      await log(q, id, 'RFQ_AWARDED',
        `Awarded to ${winner.supplier_name} (L${winner.rank}) at ${formatMinor(winner.total_minor, rfq.currency)}` + (trimmed ? ` — ${trimmed}` : ''),
        { supplierId: winner.supplier_id, actorId: actor.id, metadata: { rank: winner.rank, totalMinor: winner.total_minor } }, now);
    });
    onChange(id);
    return getRfq(actor, id, now);
  }

  // ---------- supplier action ----------

  async function submitBid(actor, rfqId, input, now = Date.now(), { idempotencyKey } = {}) {
    if (actor.role !== 'SUPPLIER' || !actor.supplier_id) throw new AppError(403, 'Only suppliers can bid');
    const bid = validateBid(input);
    const result = await db.tx((q) => idempotent(q, actor, idempotencyKey, `bid:${rfqId}`, input, async () => {
      const rfq = await loadForActor(q, actor, rfqId, { lock: true }); // serializes bids on this auction
      const status = computeStatus(rfq, now);
      if (status === 'UPCOMING') throw new AppError(409, 'Bidding has not started yet');
      if (status === 'PAUSED') throw new AppError(409, 'The auction is paused by the buyer; please wait for it to resume');
      if (status !== 'ACTIVE') throw new AppError(409, 'Auction is closed; bids are no longer accepted');

      const existing = await getBids(q, rfqId);
      const before = rankBids(existing);
      const myBest = before.find((r) => r.supplier_id === actor.supplier_id);
      const ruleError = checkBidAllowed({
        totalMinor: bid.totalMinor, myBest, l1: before[0], mySupplierId: actor.supplier_id, cfg: rfq, currency: rfq.currency,
      });
      if (ruleError) throw new AppError(409, ruleError);

      const { rows } = await q(`INSERT INTO bids (rfq_id, supplier_id, carrier_name, freight_charges_minor, origin_charges_minor,
        destination_charges_minor, total_minor, transit_time_days, quote_valid_until, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [rfqId, actor.supplier_id, bid.carrierName, bid.freightMinor, bid.originMinor, bid.destinationMinor,
        bid.totalMinor, bid.transitTimeDays, bid.quoteValidUntil, now]);
      const bidId = rows[0].id;
      const after = rankBids([...existing, { id: bidId, supplier_id: actor.supplier_id, total_minor: bid.totalMinor, created_at: now }]);
      const myRank = after.find((r) => r.supplier_id === actor.supplier_id).rank;
      const totalFormatted = formatMinor(bid.totalMinor, rfq.currency);

      await log(q, rfqId, 'BID_SUBMITTED', `${actor.company_name} (${bid.carrierName}) bid ${totalFormatted} — now L${myRank}`, {
        supplierId: actor.supplier_id, actorId: actor.id, metadata: { bidId, totalMinor: bid.totalMinor, totalFormatted, rank: myRank },
      }, now);

      let extension = null;
      if (now >= rfq.current_close_at - rfq.trigger_window_minutes * MIN) {
        const decision = evaluateTrigger({ triggerType: rfq.trigger_type, before, after });
        if (decision.triggered) {
          if (rfq.current_close_at >= rfq.forced_close_at) {
            await log(q, rfqId, 'EXTENSION_CAPPED', `${decision.reason}, but the auction is already at its forced close time; no extension`,
              { metadata: { reason: decision.reason } }, now);
          } else {
            const { newCloseAt, capped } = computeExtension({
              currentCloseAt: rfq.current_close_at, extensionMinutes: rfq.extension_minutes, forcedCloseAt: rfq.forced_close_at,
            });
            await q('UPDATE rfqs SET current_close_at = $1, extension_count = extension_count + 1 WHERE id = $2', [newCloseAt, rfqId]);
            extension = { from: rfq.current_close_at, to: newCloseAt, capped, reason: decision.reason };
            await log(q, rfqId, 'TIME_EXTENDED',
              capped ? `Bid close time extended to the forced close time (+${Math.round((newCloseAt - rfq.current_close_at) / MIN)} min)`
                : `Bid close time extended by ${rfq.extension_minutes} min`,
              { metadata: extension }, now);
          }
        }
      }
      return { bidId, rank: myRank, totalMinor: bid.totalMinor, extension };
    }));
    if (!result.replayed) onChange(rfqId);
    return result;
  }

  // ---------- scheduler ----------

  /**
   * Persist time-based status transitions and log start/close events. Run by the scheduler leader.
   * Rows are locked with SKIP LOCKED so a bid that is extending an auction at this exact moment is
   * never overruled by a stale read; that RFQ is simply re-checked on the next tick.
   */
  async function syncStatuses(now = Date.now()) {
    const changed = await db.tx(async (q) => {
      const { rows } = await q(`SELECT * FROM rfqs WHERE paused_at IS NULL AND cancelled_at IS NULL AND awarded_at IS NULL AND (
          (status = 'UPCOMING' AND bid_start_at <= $1) OR (status IN ('UPCOMING','ACTIVE') AND current_close_at <= $1))
        FOR UPDATE SKIP LOCKED`, [now]);
      const ids = [];
      for (const rfq of rows) {
        const status = computeStatus(rfq, now);
        if (status === rfq.status) continue;
        if (rfq.status === 'UPCOMING') await log(q, rfq.id, 'AUCTION_STARTED', 'Bidding opened', {}, rfq.bid_start_at);
        if (status === 'CLOSED') await log(q, rfq.id, 'AUCTION_CLOSED', 'Auction closed', {}, rfq.current_close_at);
        if (status === 'FORCE_CLOSED') await log(q, rfq.id, 'AUCTION_FORCE_CLOSED', 'Auction closed at its forced close time', {}, rfq.current_close_at);
        await q('UPDATE rfqs SET status = $1, closed_at = $2 WHERE id = $3', [status, status === 'ACTIVE' ? null : rfq.current_close_at, rfq.id]);
        ids.push(rfq.id);
      }
      return ids;
    });
    changed.forEach(onChange);
    return changed;
  }

  /** Housekeeping, run by the scheduler leader. */
  async function purgeIdempotencyKeys(now = Date.now(), maxAgeMs = 24 * 60 * MIN) {
    return (await db.query('DELETE FROM idempotency_keys WHERE created_at < $1', [now - maxAgeMs])).rowCount;
  }

  // ---------- metrics dashboard ----------

  async function getDashboard(actor, now = Date.now()) {
    if (actor.role !== 'BUYER') throw new AppError(403, 'Only buyers can view the dashboard');
    const rfqs = (await db.query(`SELECT r.*, (SELECT COUNT(*) FROM rfq_invitations i WHERE i.rfq_id = r.id) AS invited_count
      FROM rfqs r WHERE r.buyer_id = $1 ORDER BY r.created_at DESC`, [actor.id])).rows;
    const bids = rfqs.length
      ? groupBy((await db.query('SELECT * FROM bids WHERE rfq_id = ANY($1::bigint[])', [rfqs.map((r) => r.id)])).rows, 'rfq_id')
      : new Map();
    const rows = rfqs.map((r) => ({
      id: r.id, reference_id: r.reference_id, name: r.name, currency: r.currency, status: computeStatus(r, now),
      metrics: computeRfqMetrics({ bids: bids.get(r.id) || [], extensionCount: r.extension_count, invitedCount: r.invited_count }),
    }));
    const finished = rows.filter((r) => ['CLOSED', 'FORCE_CLOSED', 'AWARDED'].includes(r.status) && r.metrics.bidCount > 0);
    const avg = (list, f) => {
      const vals = list.map(f).filter((v) => v != null);
      return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;
    };
    const group = (list) => ({ count: list.length, avgSavingsPct: avg(list, (r) => r.metrics.savingsPct), avgBidsPerRfq: avg(list, (r) => r.metrics.bidCount) });
    const byStatus = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    return {
      totals: { rfqs: rows.length, finished: finished.length, byStatus },
      averages: {
        bidsPerRfq: avg(finished, (r) => r.metrics.bidCount),
        suppliersPerRfq: avg(finished, (r) => r.metrics.supplierCount),
        participationPct: avg(finished, (r) => r.metrics.participationPct),
        savingsPct: avg(finished, (r) => r.metrics.savingsPct),
        extensionsPerRfq: avg(finished, (r) => r.metrics.extensionCount),
      },
      extendedVsNot: {
        extended: group(finished.filter((r) => r.metrics.extensionCount > 0)),
        notExtended: group(finished.filter((r) => r.metrics.extensionCount === 0)),
      },
      rfqs: rows,
    };
  }

  return {
    listSuppliers, listRfqs, getRfq, createRfq, updateRfq, inviteSuppliers,
    pauseRfq, resumeRfq, cancelRfq, awardRfq, submitBid, syncStatuses, purgeIdempotencyKeys, getDashboard,
  };
}
