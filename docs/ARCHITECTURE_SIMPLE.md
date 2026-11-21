# The Architecture, Explained Simply

This is the plain-language version. If you want the technical details, read [HLD.md](HLD.md) and [CODE_WALKTHROUGH.md](CODE_WALKTHROUGH.md). This page tries to explain the *ideas* without jargon.

---

## 1. What the app does, in one paragraph

A company (the **buyer**) needs something shipped. Instead of calling transport companies one by one, it opens an **auction**. Invited transport companies (the **suppliers**) type in their prices, and anyone can lower their price at any time to beat the others. The cheapest one is "L1" (first place). If someone lowers their price in the last few minutes, the auction gets **a few extra minutes** so the others can respond. That's what stops people from sneaking in a last-second bid. There's also a **hard deadline** (the "forced close") that the auction can never go past. When it ends, the buyer picks a winner.

---

## 2. The big picture: five pieces

Think of it like a **restaurant**:

```
   👥 Customers          🧾 Menu & table         🚪 Front door         👩‍🍳 Kitchen             🗄️ Pantry & ledger
 (buyers/suppliers) ──►  (React website)  ──►  (load balancer) ──►  (app servers)  ──►  (PostgreSQL database)
                                ▲                                         │
                                └──────────── 🔔 "Your order changed!" ◄──┘
                                              (live updates)
```

| Piece | Restaurant analogy | What it really is | What it does |
|---|---|---|---|
| **Website** | The menu and your table | React app in the browser (`frontend/`) | Shows the auctions, the countdown and the bid form. It **asks** the kitchen for everything; it never decides anything important itself. |
| **Load balancer** | The front door / host | nginx (`deploy/nginx.conf`) | Sends each request to whichever kitchen is least busy. |
| **App servers** | The kitchen (there can be several cooks) | Node.js + Express (`backend/src/`) | Checks who you are, checks the rules, processes bids, extends auctions. **This is where all the decisions are made.** |
| **Database** | The pantry and the ledger book | PostgreSQL | Remembers everything: users, auctions, every bid, every log entry. It's the single source of truth. |
| **Live updates** | The bell that rings when your order changes | Server-Sent Events (SSE) | When anything changes, every open browser is told "auction #42 changed, please refresh", and it does so instantly. |

The most important rule of the whole design:

> **The browser shows things; the server decides things; the database remembers things.**

---

## 3. Following one bid from start to finish

Say Maersk (a supplier) types in **$2,270** and presses **Confirm bid**.

```
 Maersk's browser          App server                                    Database
 ────────────────          ──────────                                    ────────
 1. "Bid $2,270" ───────►  2. Who are you? (checks login cookie)
                           3. Too many bids per minute? (rate limit)
                           4. "Lock auction #42, I'm working on it" ───► 🔒 (others wait)
                           5. Check the rules:
                              • Is the auction open (not paused/closed)?
                              • Were you invited?
                              • Is it lower than your last bid by enough?
                           6. Save the bid  ─────────────────────────────► 💾
                           7. Did the ranking change in the last X minutes?
                              → yes: move the closing time +Y minutes ───► 💾 (never past the hard deadline)
                           8. Write it in the activity log ──────────────► 💾
                           9. "Unlock, done" ────────────────────────────► 🔓
 10. "You're L1! Auction   ◄─────
     extended 2 minutes"
                          11. Ring the bell: "auction #42 changed" ──────► 🔔 → every server → every open browser
 Hapag's browser updates by itself: "You are now L2"
 Buyer's browser updates by itself: the new ranking and the new close time
```

Steps 4 and 9 are the clever part, and the next section explains why.

---

## 4. The five "hard problems" and how each is solved

### Problem 1: Two people bid at the exact same moment
**What could go wrong:** both bids read "the auction closes at 6:00", both add 5 minutes, and both save "6:05". One extension is lost. Prices and rankings could get mixed up too.

**The fix:** a **lock on that one auction**, like a single key to the ledger page. The second bid waits a few milliseconds until the first finishes, then sees the correct, updated state. Other auctions aren't blocked; each auction has its own key.

**Proof:** a test fires 20 bids at the same instant, and all 20 extensions are counted. With the lock removed, the same test fails.

### Problem 2: Suppliers must not see each other's prices
**What could go wrong:** if the server sent every price to the browser and the page merely *hid* them, anyone could open their browser's developer tools and see them.

**The fix:** the server builds a **different answer for each role**. A buyer gets everything. A supplier gets only "you are L2 of 4, your best price is $2,400" (plus the lowest price, if the buyer allows it). Competitor names and prices are **never sent** to the supplier at all. Even the activity log is rewritten to say "A competitor submitted a bid".

### Problem 3: A double-click or a bad Wi-Fi moment could submit a bid twice
**The fix:** each bid carries a **receipt number** (an "idempotency key"). If the same receipt number arrives twice, the server says "I already did that one, here's the original result" instead of recording a second bid.

### Problem 4: Running more than one server
More servers means more capacity, but they have to cooperate:

| Question | Answer |
|---|---|
| "Am I logged in?" when my next request lands on a different server | Login sessions are stored **in the database**, so every server can check them. |
| "Who closes the auction when time runs out?" | Every server tries to grab one special "manager" lock in the database. **Only the one holding it** runs the closing job. If that server crashes, another grabs the lock within a second. |
| "How does a bid on server A update a browser connected to server B?" | Server A posts a tiny note on the database's **noticeboard** (`NOTIFY`). Every server is **listening** (`LISTEN`) and passes it on to its own browsers. |
| "How do we stop someone guessing passwords across servers?" | The rate-limit counters also live in the database, so all servers share them. |

Because nothing important is kept inside an individual server, you can add or remove servers freely. They're "stateless".

### Problem 5: Someone tries to undercut by 1 cent to grab first place
**The fix:** the buyer sets a **minimum decrement**, for example "each new bid must be at least $25, or 0.5%, lower". This applies both to lowering your own price and to taking first place from someone else.

---

## 5. Who can do what

```
            BUYER                                       SUPPLIER
   ┌───────────────────────────┐            ┌───────────────────────────┐
   │ • create / edit an RFQ    │            │ • see auctions they were  │
   │   (edit only before start)│            │   invited to              │
   │ • invite suppliers        │            │ • see OWN rank and bids   │
   │ • pause / resume / cancel │            │ • place bids (each lower  │
   │ • see ALL bids and names  │            │   than the last)          │
   │ • award the winner        │            │ • see if they won         │
   │ • dashboard of results    │            │                           │
   └───────────────────────────┘            └───────────────────────────┘
```

A supplier who wasn't invited gets "not found", not "forbidden", so they can't even tell that the auction exists.

---

## 6. An auction's life

```
 UPCOMING ──(start time)──► ACTIVE ──(close time passes)──► CLOSED ──(buyer picks winner)──► AWARDED
                              │  ▲                    └────► FORCE CLOSED (hit the hard deadline) ──► AWARDED
                       pause  │  │ resume
                              ▼  │
                             PAUSED      (any time before award: buyer can CANCEL, with a reason)
```

- **Extensions** happen while ACTIVE: a late bid moves the close time later, but **never past** the forced close.
- **Pause** freezes the clock. On resume, the close time *and* the hard deadline both move forward by the paused time, so nobody loses bidding time.
- A background **scheduler** checks every second and moves auctions from Upcoming to Active to Closed.

---

## 7. Where the data lives

One database, about ten tables. In plain words:

| Table | Think of it as |
|---|---|
| `users`, `suppliers`, `sessions` | The guest list, and who's currently signed in |
| `rfqs` + `auction_configs` | Each auction and its rules (X, Y, trigger type, minimum drop, what suppliers can see) |
| `rfq_invitations` | Who's allowed into each auction |
| `bids` | Every price ever submitted (nothing is overwritten) |
| `activity_logs` | The diary: bids, extensions and the reason for each, pauses, closes, awards |
| `idempotency_keys` | The receipt numbers, so nothing happens twice |
| `rate_limits` | Counters for "too many attempts" |

Money is stored as **whole cents** (`$12.34` → `1234`), so there are no rounding errors.

**No database installed?** The app then runs a built-in copy of PostgreSQL inside itself (called PGlite). It's the same language and the same tables, but only **one** app process can use it at a time. That's perfect for trying it out and for tests. For real use with several servers, you point it at a real PostgreSQL with `DATABASE_URL`.

---

## 8. How we know it works

There are about 104 automated tests, in layers, each checking something different:

| Layer | Checks… |
|---|---|
| Rule tests | the maths: ranking, extensions, the hard-deadline cap, the minimum drop |
| Service tests | the business rules against a real database |
| Concurrency tests | 20 bids at once, duplicate clicks, a bid at the exact moment of closing |
| API tests | every page and action, for every type of user: who gets in, who gets blocked |
| Frontend tests | the website's widgets, and that its "your next bid must be ≤ $X" hint matches the server exactly |
| Browser tests (Playwright) | real browser windows: a buyer and two suppliers bidding live and watching each other's screens update |

---

## 9. Running it

```bash
npm run install:all
```

```bash
npm run build && npm run seed && npm start
```

Then open http://localhost:4000 and sign in as `buyer@demo.test` or `maersk@demo.test`. The password for both is `demo1234`. See the README's Troubleshooting section if it doesn't start.

---

## 10. The whole thing in five sentences

1. Buyers and suppliers use a **website** that only *shows* things.
2. Every action goes to **app servers** that check the rules and make every decision.
3. Each auction gets a **lock** while a bid is processed, so simultaneous bids can never corrupt it.
4. Everything is stored in **one database**, which also acts as the noticeboard and manager-lock that lets many servers cooperate.
5. Every change is pushed **live** to every open screen, but each person sees only what their role allows.
