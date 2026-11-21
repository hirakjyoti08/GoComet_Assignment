-- 001: initial PostgreSQL schema.
-- Timestamps: BIGINT epoch milliseconds (UTC). Money: BIGINT minor units (cents/paise).

CREATE TABLE users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          TEXT   NOT NULL,
  name           TEXT   NOT NULL,
  role           TEXT   NOT NULL CHECK (role IN ('BUYER','SUPPLIER')),
  password_hash  TEXT   NOT NULL,                     -- scrypt$<salt>$<hash>
  created_at     BIGINT NOT NULL
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE sessions (
  token_hash  TEXT   PRIMARY KEY,                     -- sha256 of the cookie token
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  BIGINT NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE suppliers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT   NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE UNIQUE INDEX suppliers_name_lower_uq ON suppliers (lower(name));

CREATE TABLE rfqs (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  buyer_id             BIGINT NOT NULL REFERENCES users(id),
  reference_id         TEXT   NOT NULL UNIQUE,
  name                 TEXT   NOT NULL,
  pickup_date          TEXT   NOT NULL,
  currency             TEXT   NOT NULL,
  bid_start_at         BIGINT NOT NULL,
  bid_close_at         BIGINT NOT NULL,
  current_close_at     BIGINT NOT NULL,
  forced_close_at      BIGINT NOT NULL,
  is_british_auction   BOOLEAN NOT NULL DEFAULT TRUE,
  status               TEXT   NOT NULL DEFAULT 'UPCOMING'
                       CHECK (status IN ('UPCOMING','ACTIVE','PAUSED','CLOSED','FORCE_CLOSED','CANCELLED','AWARDED')),
  extension_count      INTEGER NOT NULL DEFAULT 0,
  paused_at            BIGINT,
  total_paused_ms      BIGINT NOT NULL DEFAULT 0,
  cancelled_at         BIGINT,
  cancel_reason        TEXT,
  awarded_supplier_id  BIGINT REFERENCES suppliers(id),
  awarded_bid_id       BIGINT,
  award_reason         TEXT,
  awarded_at           BIGINT,
  closed_at            BIGINT,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL,
  CHECK (bid_close_at > bid_start_at),
  CHECK (forced_close_at > bid_close_at),
  CHECK (current_close_at <= forced_close_at)
);
CREATE INDEX rfqs_status_close_idx ON rfqs (status, current_close_at);
CREATE INDEX rfqs_buyer_idx ON rfqs (buyer_id, created_at DESC);

CREATE TABLE auction_configs (
  rfq_id                  BIGINT PRIMARY KEY REFERENCES rfqs(id) ON DELETE CASCADE,
  trigger_window_minutes  INTEGER NOT NULL CHECK (trigger_window_minutes > 0),
  extension_minutes       INTEGER NOT NULL CHECK (extension_minutes > 0),
  trigger_type            TEXT    NOT NULL CHECK (trigger_type IN ('BID_RECEIVED','ANY_RANK_CHANGE','L1_RANK_CHANGE')),
  min_decrement_type      TEXT    NOT NULL DEFAULT 'AMOUNT' CHECK (min_decrement_type IN ('AMOUNT','PERCENT')),
  min_decrement_value     BIGINT  NOT NULL DEFAULT 0 CHECK (min_decrement_value >= 0),
  supplier_visibility     TEXT    NOT NULL DEFAULT 'RANK_ONLY' CHECK (supplier_visibility IN ('RANK_ONLY','RANK_AND_L1_PRICE'))
);

CREATE TABLE rfq_invitations (
  rfq_id       BIGINT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  supplier_id  BIGINT NOT NULL REFERENCES suppliers(id),
  invited_at   BIGINT NOT NULL,
  PRIMARY KEY (rfq_id, supplier_id)
);
CREATE INDEX rfq_invitations_supplier_idx ON rfq_invitations (supplier_id);

CREATE TABLE bids (
  id                         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rfq_id                     BIGINT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  supplier_id                BIGINT NOT NULL REFERENCES suppliers(id),
  carrier_name               TEXT   NOT NULL,
  freight_charges_minor      BIGINT NOT NULL CHECK (freight_charges_minor >= 0),
  origin_charges_minor       BIGINT NOT NULL CHECK (origin_charges_minor >= 0),
  destination_charges_minor  BIGINT NOT NULL CHECK (destination_charges_minor >= 0),
  total_minor                BIGINT NOT NULL CHECK (total_minor > 0),
  transit_time_days          INTEGER NOT NULL CHECK (transit_time_days > 0),
  quote_valid_until          TEXT   NOT NULL,
  created_at                 BIGINT NOT NULL
);
CREATE INDEX bids_rfq_supplier_idx ON bids (rfq_id, supplier_id, created_at);
CREATE INDEX bids_rfq_amount_idx ON bids (rfq_id, total_minor);
ALTER TABLE rfqs ADD CONSTRAINT rfqs_awarded_bid_fk FOREIGN KEY (awarded_bid_id) REFERENCES bids(id);

CREATE TABLE activity_logs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rfq_id         BIGINT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  type           TEXT   NOT NULL CHECK (type IN ('RFQ_CREATED','RFQ_UPDATED','SUPPLIER_INVITED','AUCTION_STARTED','BID_SUBMITTED',
                   'TIME_EXTENDED','EXTENSION_CAPPED','AUCTION_PAUSED','AUCTION_RESUMED','AUCTION_CLOSED',
                   'AUCTION_FORCE_CLOSED','AUCTION_CANCELLED','RFQ_AWARDED')),
  message        TEXT   NOT NULL,
  supplier_id    BIGINT REFERENCES suppliers(id),
  actor_user_id  BIGINT REFERENCES users(id),
  metadata       JSONB,
  created_at     BIGINT NOT NULL
);
CREATE INDEX activity_logs_rfq_idx ON activity_logs (rfq_id, created_at DESC, id DESC);

-- Idempotency: a retried POST with the same key returns the original response instead of acting twice.
CREATE TABLE idempotency_keys (
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           TEXT   NOT NULL,
  scope         TEXT   NOT NULL,                      -- e.g. 'bid:42'
  request_hash  TEXT   NOT NULL,
  status_code   INTEGER,
  response      JSONB,
  created_at    BIGINT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- Fixed-window rate limiting shared by all app instances.
CREATE TABLE rate_limits (
  bucket        TEXT    NOT NULL,
  window_start  BIGINT  NOT NULL,
  count         INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
