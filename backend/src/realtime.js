// Live updates across any number of app instances.
//
//   instance A: bid committed ─► NOTIFY rfq_updated '42' ─► PostgreSQL
//                                                             │ (LISTEN on every instance)
//   instance A, B, C … ◄──────────────────────────────────────┘
//        └─► local SSE hub ─► each connected browser re-fetches RFQ 42 through the permission-checked API
//
// Only ids travel over the channel and the SSE stream, never data.
import { logger } from './logger.js';

const CHANNEL = 'rfq_updated';

export function createEventHub() {
  const clients = new Set();
  return {
    add(res) { clients.add(res); res.on('close', () => clients.delete(res)); },
    broadcast(rfqId) {
      const msg = `event: rfq_updated\ndata: ${JSON.stringify({ rfqId })}\n\n`;
      for (const res of clients) res.write(msg);
    },
    size: () => clients.size,
    closeAll() { for (const res of clients) res.end(); clients.clear(); },
  };
}

/**
 * Bridges the database notification channel and the local hub.
 * publish() is what the service calls after a commit; every instance (including this one) receives it.
 */
export async function createRealtime(db, hub) {
  await db.listen(CHANNEL, (payload) => {
    const id = Number(payload);
    if (Number.isSafeInteger(id)) hub.broadcast(id);
  });
  return {
    publish(rfqId) {
      db.notify(CHANNEL, String(rfqId)).catch((err) => {
        // Fall back to local delivery; other instances' clients still have the 15 s poll.
        logger.warn({ err, rfqId }, 'notify failed; broadcasting locally only');
        hub.broadcast(rfqId);
      });
    },
  };
}
