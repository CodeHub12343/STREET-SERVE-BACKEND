# Support runbooks

**Written 2026-08-04** (roadmap task 8.8). For the person answering a customer, seller, or hub owner
— not for on-call. Engineering alerts live in [RUNBOOKS.md](RUNBOOKS.md); this is what to do when a
**person** contacts you.

Three procedures, chosen because each is a situation where someone is upset about money and the
wrong answer causes real harm: **RTO delinquency**, **consignment termination**, and **disputes**.

---

## Ground rules

These apply to all three and matter more than any individual step.

1. **Never promise an outcome you cannot execute yourself.** Every action below is a real endpoint
   with a real actor. If a remedy belongs to the seller, you cannot grant it — you can only ask
   them. Saying "I'll get that waived for you" and then failing is worse than saying "that's the
   seller's call, and here's how I'll ask".
2. **Read the record before you read the ticket's summary.** Agreements, consignments, and disputes
   all carry an immutable history. The customer's account of events is a starting point, not the
   facts.
3. **Money moves through the product, never by hand.** There is no support tool that edits a
   balance. If the correct outcome needs money to move, it moves through a refund, a remedy, or a
   dispute resolution — each of which leaves a record. A manual adjustment leaves the books
   disagreeing with reality, which is the thing every integrity job exists to catch.
4. **Check what was actually delivered.** `GET /api/v1/admin/notices/undelivered` lists contractual
   notices no channel accepted. If someone says "nobody told me", **look before you disagree** —
   they may be right, and if the notice is in that list they are.

---

## 1 · RTO delinquency

*"I missed a payment."* / *"They're charging me a late fee."* / *"I want to give it back."*

### First, read the state

`GET /api/v1/rto/agreements/:id` — the status tells you which conversation you are in:

| Status | What it means | What is happening automatically |
|---|---|---|
| `active` | On track | Installments charge on schedule |
| `grace` | A payment failed | The customer is inside the grace window; no penalty yet |
| `late` | Grace expired | The disclosed late fee has been assessed **once**; reminders continue |
| `arrangement` | A catch-up plan was agreed | Charging follows the arrangement |
| `paused` | The seller paused it | Nothing charges until reinstated |
| `return_pending` | A return was requested | Charging has stopped |
| `cancelled` / `completed` | Ended | Nothing further |

Grace length depends on payment frequency: **daily 1 day, weekly 3, biweekly and twice-monthly 5,
monthly 7**. After grace, `late`. Seven days after that, `pre_recovery` — the stage where the seller
is asked to make a decision.

### What you can tell the customer, truthfully

- **The late fee is charged once per missed payment, not per day.** It is not auto-collected — it is
  added to what they owe. Paying the missed installment stops further fees.
- **A late fee buys them nothing.** It carries no ownership credit. Neither do arrears payments.
  This is worth saying plainly, because people assume any payment moves them closer to owning it.
- **Payments already made are not automatically refundable on return.** Whether they are depends on
  the seller's listing terms (`paymentsRefundableOnReturn`). Use the **return preview** below rather
  than guessing.

### Actions, and whose they are

| Action | Endpoint | Who can do it |
|---|---|---|
| Preview a return (no commitment) | `GET /rto/agreements/:id/return-preview` | Customer |
| Request a return | `POST /rto/agreements/:id/return` | Customer |
| Pay off early | `POST /rto/agreements/:id/payoff` | Customer |
| Defer a payment | `POST /rto/agreements/:id/defer` | **Seller** |
| Record a partial payment | `POST /rto/agreements/:id/partial-payment` | **Seller** |
| Agree a catch-up arrangement | `POST /rto/agreements/:id/arrangement` | **Seller** |
| Pause the agreement | `POST /rto/agreements/:id/pause` | **Seller** |
| Reinstate after a pause | `POST /rto/agreements/:id/reinstate` | **Seller** |

**The §50 remedies are the seller's, not support's, and not the customer's.** A customer who could
pause their own agreement would not be receiving forbearance — they would have an option to stop
paying. Your job when a customer asks for one is to put the request to the seller, quickly, and tell
the customer that is what you have done.

### Procedure

1. **Read the agreement and the ledger.** `GET /rto/agreements/:id` and `/statements`. Establish
   what was charged, what failed, and when.
2. **Check the notices actually reached them.** If the §49 reminders are in the undelivered list,
   lead with that: they were not warned, and that changes the conversation.
3. **Run the return preview** if they are considering giving it back — even if they have not asked.
   It states in plain words what they get back and what they do not. Read it to them verbatim;
   paraphrasing a disclosure is how a dispute starts.
4. **If they want forbearance,** contact the seller with the specific ask (defer one payment / pause
   30 days / arrangement over N payments). Give the seller the customer's payment history, not a
   summary of their story.
5. **Never cancel an agreement to "help".** Cancellation is a §50 remedy with consequences for
   ownership credit. The customer-initiated route is a **return**, which is disclosed.

### Escalate to engineering when

- The status does not match the payment history (e.g. `active` with three missed installments).
- A late fee was assessed more than once for the same installment number.
- A payment was taken while the agreement was `paused` or `return_pending`.

---

## 2 · Consignment termination

*"They ended my consignment."* / *"I want my stock back."* / *"My items expired and nobody told me."*

### First, read the state

`GET /api/v1/checkouts/:id/settlement` and the checkout itself. The relevant fields are
`status`, `expires_at`, `termination_notice_at`, `termination_effective_at`, and `notices_sent`.

### The rules, so you can answer without checking with anyone

- **Termination gives NOTICE; it does not end the consignment on the spot.** The notice period is
  set by the value of the stock: **≤ $100 → 3 days, ≤ $500 → 7 days, above that → 14 days.** Higher
  value means more notice, because more is at stake for the seller.
- **Either party may terminate.** Both the seller and the hub/product owner can give notice. Neither
  can end it instantly.
- **Expiry notices go out at 14, 7, 3, and 0 days.** They are recorded — see below.
- **Unsold stock moves to Return-Pending, not to "forfeited".** There is a return window
  (24-hour grace after the expected return), and after that the checkout is flagged for **human**
  abandonment review. Nothing is ever automatically kept.

### If they say "nobody told me"

Check before you disagree.

```
GET /api/v1/admin/notices/undelivered?days=90
```

Every §37 and §38 notice is recorded with which channels were tried and whether any accepted.
If the notice is listed as undelivered, **they are right, and that is the platform's problem, not
theirs.** Extend the term (`POST /checkouts/:id/extend`) and say why.

### Actions

| Situation | Action |
|---|---|
| Seller needs more time | `POST /checkouts/:id/extend` (seller) |
| Stock is not moving | `POST /checkouts/:id/reduce-price` (seller) |
| Either party wants out | `POST /checkouts/:id/end` — **gives notice**, does not end it |
| Stock is coming back | `POST /checkouts/:id/return` |
| Commission needs changing | `POST /checkouts/:id/commission` (§36) |

### Procedure

1. Read the checkout and settlement. Establish who gave notice, when, and what notice period
   applied.
2. Confirm the notice was delivered. If it was not, that is the answer — fix it and extend.
3. If stock is in Return-Pending, tell the seller exactly what the return terms are (the checkout
   carries them) rather than describing them from memory.
4. If the checkout is in abandonment review, **do not resolve it yourself.** It is flagged for
   lawful review precisely because "the platform kept someone's goods" is a decision that needs a
   named human, not a support action.

### Escalate to engineering when

- A consignment ended without a notice period having elapsed.
- Settlement figures do not reconcile to the sale (`GET /checkouts/:id/settlement`).
- Stock returned to a hub but the seller's debt did not clear.

---

## 3 · Disputes

*"I never got my order."* / *"The item wasn't as described."* / *"They're claiming I damaged it."*

### The SLA

**5 business days** (`DISPUTE_SLA_DAYS`). The dispute carries `sla_due_at`; an approaching breach
raises a NOTICE alert on the ops side. Do not let a dispute sit unread because it looks
straightforward — the clock is the promise.

### Actions

| Action | Endpoint | Who |
|---|---|---|
| Open a dispute | `POST /api/v1/disputes` | Either party |
| Read one | `GET /api/v1/disputes/:id` | Participants, admin |
| Add evidence | `POST /api/v1/disputes/:id/evidence` | Participants |
| Resolve | `POST /api/v1/disputes/:id/resolve` | **Admin only** |

Resolution takes an outcome of **`upheld`** or **`dismissed`**, a written `resolution`, and
optionally a `clawbackTransactionId`. Supplying the transaction issues a **documented reversal** —
both parties are notified. There is deliberately no silent debit.

### Procedure

1. **Collect evidence from both sides before resolving.** A dispute resolved on one account is a
   dispute you will hear about again.
2. **Read the condition reports** where there is one (RTO delivery and return both capture photos,
   serial numbers, and dual acknowledgment). They exist precisely so damage arguments are not
   resolved on assertion.
3. **Write the `resolution` for the losing party to read.** It is stored and shown. "Dismissed" with
   no reasoning is how someone concludes the platform is arbitrary — and they will say so publicly.
4. **Use the clawback only when money must actually move back.** It reverses a real transaction and
   notifies both parties. If the correct outcome is "no money moves", say that in the resolution
   rather than resolving with a zero clawback.
5. **Never resolve a dispute you are personally involved in.** Resolution is audited with your
   actor id; it will be visible later, and it should be someone else's.

### Escalate to engineering when

- A clawback fails or partially applies.
- The dispute's referenced transaction does not exist or is already refunded.
- Resolving throws an `INVALID_STATE_TRANSITION` (means it is already resolved — find out by whom).

---

## What support cannot do, by design

Stating these plainly so nobody promises them:

- **Edit a balance, a ledger entry, or a settlement.** They are immutable. Correction happens
  through a refund, a remedy, or a dispute resolution — all of which leave a record.
- **Mark an agreement as reviewed, or bypass the §60 clickwrap.** RTO acceptance is gated closed
  until the attorney-reviewed text lands (M-1). If a seller asks why they cannot publish an RTO
  listing, that is the reason and it is not a bug.
- **Grant a seller's §50 remedy on their behalf.** You can ask them. You cannot decide for them.
- **Resolve an abandonment review.** It needs a named human decision, deliberately.
- **Delete a review, or hide a rating.** Photo moderation hides *photos only* — never the rating or
  the words, because a business that could bury a bad review by reporting its picture would.
