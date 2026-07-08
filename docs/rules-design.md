# Rules engine design

This document defines how rules and insights work. It is the design of record for
the rules engine and supersedes the shorter "Rules and insights" summary in
`architecture.md`. It describes the shipped design; what is deliberately not built
yet is listed at the end.

## What the engine is for

The engine runs continuously over connected-account data and surfaces only the
findings worth acting on. Success is not "how many rules exist" but "how reliably
the engine turns hundreds of possible signals into the few that matter, ranked by
money at stake." The ranking function, not any single rule, is the product.

## Principles

- **Rules are data, not code.** A rule is a row in the `rules` table: metadata
  plus a **SQL query** (deterministic) or a prompt (LLM). Built-in rules ship as a
  seed loaded into that table on startup; new rules are added or changed as rows —
  no code, no redeploy. The engine is a generic interpreter that runs whatever
  rows the table holds, so built-in and downloaded rules are identical to it. (A
  future job can poll a versioned rule-definition file and upsert changed rows.)
- **One finding contract.** Every rule, regardless of how it is evaluated,
  emits the same `Finding` shape. Downstream ranking, delivery, and action never
  need to know which engine produced a finding.
- **Money math is deterministic.** The estimated dollar impact of a finding is
  always computed by deterministic code, even when a language model is involved
  in detection or explanation. A model may propose; only code may state a number.
- **Detection is decoupled from action.** A rule produces a finding; a separate
  action layer decides whether to notify, generate an artifact, or execute, based
  on the trust the user has granted that rule.
- **Quiet by default.** The engine stays silent unless a finding clears the
  ranking threshold. Deduplication and suppression are first-class, not
  afterthoughts.
- **Financial connections are read-only by default.** Any action that moves money
  is opt-in, per rule, and revocable.

## One rule, one row

Every rule is a single row in the `rules` table, keyed by `kind`. The row carries
BOTH the definition (code/feed-owned) and the user's on/off + schedule
(user-owned):

- **Definition** — `kind` (primary key), `domain`, `executionClass` (`D` / `L` /
  `L+`), `actionTier`, `scope`, `keywords` (a regex source string for
  natural-language inference), `sql` (a `D` rule's deterministic query) OR
  `prompt` (an LLM spec), `facts` (the user facts the rule needs), `enabled`,
  `version`, and `source` (`builtin` | `downloaded` | `user`). Built-in rules are
  seeded from code on startup; downloaded rules are upserted by the feed. The
  `RuleSpec` type is the definition-only view used by the seed, the feed, and
  natural-language inference.
- **User-owned** — `active` (the on/off switch), `channel`, `cadence`,
  `scheduledHour`, `scheduledDay`, `sourceText`.

The engine runs a rule when **`enabled AND active`**. Every rule ships enabled and
**active by default**, so all of them run out of the box; each can be toggled off
individually. There is no separate "always-on" class at runtime — turning a rule
off simply clears `active`. The startup seed and the feed upsert the definition
columns only; they never touch the user's `active`, schedule, or channel, so
re-seeding can't undo a toggle. (This single table replaced an earlier split of
`rule_specs` definitions + a `rules` instances table; migration v12 folded them and
v15 dropped the vestigial `always_on` / `user_rule` columns.)

For a `D` rule the engine runs its `sql` through a read-only query runner (SQLite
stays behind the repository port). The query selects the finding-draft columns
(`title`, `detail`, `dollar_impact_minor`, `confidence`, `severity`, …) with a few
bound params (`:now_iso`, `:rule_created_at`, `:hysa_apr`, …); the engine maps each
row to a draft and finalizes it into the finding contract. Shared SQL primitives —
the UDFs `money()`, `normalize_merchant()`, `fee_like()`, the `median` aggregate,
and the `recurring_series` view — let even the gnarly recurring/temporal rules stay
pure SQL, so a downloaded rule can just `SELECT … FROM recurring_series`.

Deciding what is *recurring* is not a threshold problem. Repeated visits to one
merchant (ride-hailing, a duty-free shop) are not a subscription, while a variable
utility bill or a bi-weekly paycheck is — and no coefficient of variation on
amount or cadence separates those cleanly. So recurrence is classified by the
configured LLM, which weighs the merchant name (world knowledge — Netflix vs a
duty-free shop) against the observed pattern.

The pipeline is a deterministic prefilter feeding a model, cached so the engine
stays synchronous:

1. **Candidate generation** (`repository.listRecurringCandidates`) groups
   transactions by normalized merchant + direction across accounts and derives the
   shape features (count, span, cadence estimate, amount stats, `amount_cv`,
   `interval_cv`, category). `recurring_series` still exposes those CV columns, now
   as *features*, not gates.
2. **Classification** (`FinanceService.classifyRecurringWithModel`) sends the
   candidates to the LLM in one batched call and stores the verdicts —
   `is_recurring`, `kind`, `cadence`, `canonical_name`, `confidence` — in
   `recurring_classifications`, keyed by merchant + direction. Only candidates
   whose shape *signature* changed are re-classified, so the model is called
   sparingly. There is no heuristic fallback: with no model configured the table
   returns `model_required` and the UI routes the user to model settings.
3. **Consumption**: the recurring `D` rules and the `/v1/recurring` table just
   `JOIN recurring_classifications` and filter on `is_recurring` / `kind`. The
   engine reads a table; the model ran out-of-band.

### Merchant identity (canonical vendors)

The same vendor bills under many raw descriptions that normalize to different
merchant keys (`APPLE.COM/BILL`, `ITUNES`, `APPLE SERVICES`). A second
LLM-enrichment pipeline — identical in shape to recurring classification —
resolves each normalized merchant to a **canonical vendor** and caches it, so
rules can group by vendor rather than by raw string:

1. **Candidates** (`repository.listMerchantCandidates`) — one row per normalized
   merchant with a representative description.
2. **Identification** (`FinanceService.refreshMerchantIdentities`, default
   `identifyMerchantsWithModel`) — the model maps each merchant to a
   `canonicalName` + `canonicalSlug`, stored in `merchant_identities`. Only
   not-yet-identified merchants are sent, so the model is called sparingly; tests
   inject a `MerchantIdentifier` stub.
3. **Consumption** — `cross-card-subscription` and `cross-account-duplicate`
   `LEFT JOIN merchant_identities` and group by `COALESCE(canonical_slug,
   merchant)`, so a vendor billed under two descriptions on two cards is caught.
   With no identities the `COALESCE` falls back to the raw merchant, so the rules
   degrade cleanly.

Evaluation is tri-state. If a required fact has no value yet, the rule does not
fire — the engine emits a **question** instead (see facts).

## Execution class

The execution class is a property of the rule's condition, decided by one
question:

> Can the truth of this rule be expressed as exact logic over structured data we
> already hold?

- **Yes → `D` (deterministic).** Trigger, dedupe key, severity, and copy are
  computed locally with no model. Thresholds, comparisons, date math, arithmetic
  over facts, and joins to reference tables are all `D`. For these, determinism is
  not a cost compromise — it is higher quality: reproducible, auditable, and free
  of hallucination.
- **No, it needs meaning or judgment → `L` / `L+`.** The rule depends on the
  meaning of unstructured text, a fuzzy classification, or multi-step reasoning
  that deterministic code cannot express.
  - **`L`:** deterministic trigger, model-generated explanation from local facts.
  - **`L+`:** deterministic prefilter, then model admit/reject or reasoning, with
    a deterministic fallback.

Most rules are not at the extremes. The largest group is **hybrid**: a model
enriches data into a signal (a score or a flag) that is written back onto the
record once and cached, and a deterministic condition then reads that signal.
This keeps semantic understanding available to `D`-style conditions without a
model in the evaluation loop.

Execution class is a capability requirement, declared on the rule. **Where a
rule physically runs — a local model, a remote model, or the query engine — is a
separate routing concern decided later by a router, and it never changes the
rule's logic.** Cost optimization lives entirely in that router.

## Data sources

The engine draws on three tiers. A live external API is a distant fourth, needed
only for the rare rule whose reference data is both high-cardinality and
something the user cannot know; such rules are deferred, not faked.

1. **Connected-account stream.** Transactions, balances, holdings, liabilities,
   and connection state from the aggregation provider. This is the base and the
   cheapest to obtain.
2. **User facts.** Values the user knows but the stream does not expose — an
   employer match percentage, a policy renewal date, a mortgage rate. Facts are
   asked for, entered once, and refreshed on a cadence.
3. **Reference tables.** Slow-changing world data shipped alongside the rules and
   versioned with them — contribution limits, benchmark rates, category
   definitions. When the world changes, a new bundle updates them; no live call.

### Facts and questions

The facts layer is what lets a rule depend on external data without an external
integration. Its behavior:

- A required fact with no value turns into a **question**, not an error or a
  silent skip. The engine's evaluation of a rule is therefore tri-state: fires,
  does not fire, or blocked-on-a-question.
- Facts carry a value, a source, a confidence, and a refresh cadence. A fact
  entered by the user is lower confidence than one derived from the stream, and
  that difference propagates into the finding's confidence.
- Prefer **derive-then-confirm**: when the stream can suggest a value, pre-fill it
  and ask the user only to confirm, rather than asking them to type it in.
- Questions are ranked by the dollar impact they would unlock. The onboarding and
  follow-up surface asks the highest-value question first; it does not dump a
  form on the user.

**Fact key naming.** Facts live in one flat, global key space so that one answer
serves every rule that references the key — this sharing is the point, and it is why
keys are namespaced by the **subject of the fact** (the area of the user's life),
never by the rule domain that happens to consume it. A rule borrows facts from other
subjects freely; e.g. the employer-match rule reads `income.gross_annual`, which is
an `income` fact, not a `retirement` one. Conventions:

- Lowercase, dot-separated, one namespace level: `area.thing` (a second level only
  for a real keyed sub-entity, e.g. `insurance.auto.renewal_date`).
- The unit is carried by a suffix that pairs with the fact's `expects` hint:
  `_pct` (percent), `_minor` (integer minor units), `_date` (ISO), `_months`,
  `_frequency`.
- Current top-level namespaces: `income`, `retirement`, `tax`, `housing`, `debt`,
  `insurance`, `goals` (with `household` reserved for demographics). Notification
  thresholds, channels, and risk-tolerance-as-preference are app **settings**, not
  facts — keep the two stores distinct.

## The finding contract

Every firing produces a `Finding`:

- `id`, `ruleId`, `kind`, `domain`, `scope`, `accountId`, `createdAt` — identity,
  grouping, and dedupe.
- `title`, `detail`, `value` — human-facing copy.
- `dollarImpactMinor`, `currency` — the estimated money at stake, in signed
  integer minor units, **normalized to a common twelve-month horizon** so findings
  are comparable:
  - one-time recovery: face value, counted once in the window;
  - recurring saving: per-period amount annualized;
  - avoided loss: loss magnitude times probability (expected value);
  - pure risk (no dollar value): `0`, carried by an explicit severity instead.
- `confidence` — probability the finding is real and actionable (0..1).
- `urgency`, `effort`, `score` — the ranking inputs and the computed score.
- `severity` — derived from the score unless the spec sets it explicitly (a SQL `severity` column).
- `evidence` — the records and computation that produced the finding, so a user
  can ask "why" and get a deterministic replay rather than a model's recollection.
- `action` — the action label and the tier at which it may run (confidence-capped).

`dollarImpactMinor` and `confidence` are always present.

## Ranking and delivery

A finding's priority is:

```
score = |dollarImpactMinor(12mo)| × confidence × urgency ÷ effort
```

- **urgency** boosts findings with an approaching deadline (≥ 1).
- **effort** penalizes findings that cost the user more to act on (≥ 1).

A single suppression floor drops findings below it, **unless** the spec set
an explicit non-low severity (a risk finding with no dollar value always
surfaces). Surviving findings are returned sorted by score. Delivery pushes the
ones that are new since the last run to the configured channel; user-set mutes
and per-identity dedupe apply first, and the message is grouped by domain.

A two-tier digest/push split and deadline-forced surfacing are described here as
the intended model but are not yet built — see the end of this document.

## Actions and the trust ladder

Detection produces a finding; the action layer decides how far to act, gated by
the tier the user has granted the rule:

- **Observer** — surface only.
- **Advisor** — surface plus a generated artifact or checklist (a draft letter, a
  cancellation script, a step list).
- **Guardian** — execute after explicit one-tap approval.
- **Navigator** — execute automatically within user-set limits.

Confidence caps the tier: a finding built on low-confidence input (for example a
self-entered fact) may not run above Advisor. Autonomous action requires both a
high-confidence finding and an explicit Navigator grant. Every grant is per rule
and revocable.

Detection, the tier/confidence capping, and the **Advisor** tier are implemented:
`FinanceService.generateFindingArtifact()` drafts the document for a finding —
a dispute letter (duplicate charge, cross-account double payment), a fee-waiver
request, an APR-reduction or retention script, a cancellation — grounded strictly
in that finding's own transactions (see `ARTIFACT_SPECS`). The model only turns
the finding's facts into prose; it never invents a figure, and **Finora never
sends anything** — it drafts for the user to review and send themselves, so the
read-only promise holds. Guardian/Navigator execution is modeled in the contract
but not yet wired to act, and financial connections stay read-only.

## Domain taxonomy (UI grouping only)

Domains organize rules for the user; they do not drive engine logic.

- **Cash flow** — income timing, bill runway, idle cash, recurring spend.
- **Spending** — large charges, duplicates, subscriptions, fees, categorization
  cleanup.
- **Credit** — utilization, card interest, late or fee signals, report review.
- **Investments** — cash drag, concentration, portfolio movement, executed orders.
- **Connections** — provider status, missing tokens, stale cursors, sync health.

Additional domains (benefits, tax, medical, property) attach here as their
reference tables and facts become available, without changing the engine.

## Over-the-air rule updates

Because rules are pure data, new built-in rules can ship from a remote feed
without a code release. `FinanceService.syncRuleFeed()` fetches a configured
`RULES_FEED_URL` through the injectable `RuleFeedClient` port and validates a
`{ version, specs[] }` JSON document (e.g. a GitHub raw URL — see
`rules-feed.example.json`). The sync is **additive**:

- It **inserts** only the rules whose `kind` this install doesn't already have,
  as `source: 'downloaded'`, enabled and active by default.
- Rules already present — whether from the built-in code seed or an earlier
  sync — are **never overwritten or re-synced**. The feed distributes *new* rules;
  it does not edit existing ones.
- Dedup is by `kind`, so a repeated sync that finds nothing new is a cheap no-op
  (`applied: 0`). There is no version gate: the feed's `version` is informational
  (surfaced in the UI), not a condition on applying it.

The read-only query runner sandboxes downloaded SQL — it can never write. The feed
URL is editable and a **Check for updates** button triggers a sync
(`POST /v1/rules/sync`) under **Settings → Rules & Facts**; background services
run a silent, best-effort sync shortly after boot and once a day thereafter.
Built-ins seeded from code remain the offline floor.

## Shipped rules

All current rules are `D` (deterministic) SQL over the connected-account stream
plus shipped reference data — no user input except where noted. They are seeded
into the `rules` table on startup, enabled and active by default:

- **Cash flow** — idle cash, low / negative balance, cash runway, cash-flow
  negative, upcoming bills / overdraft, net-worth movement, employer 401(k) match
  (fact-gated).
- **Spending** — large transactions, duplicate charges, cross-account duplicate
  payments, card-testing pattern, fees and interest, subscription price increases,
  recurring subscriptions, new recurring charges, discretionary category spikes,
  cross-card duplicate subscriptions, unfamiliar merchant charges.
- **Credit** — credit utilization, card interest.
- **Investments** — brokerage cash drag, portfolio concentration, single-name
  exposure, holding value swings, executed trades, dividends received, possible
  wash sales.
- **Connections** — connection health, stale account data.

## Not yet built

- **`L` / `L+` execution.** Every shipped rule is `D` (SQL). The language-model
  path — a spec's `prompt` run as deterministic prefilter then model
  admit/reject/summarize with a deterministic fallback — is not implemented.
  Pure-LLM summaries (weekly digest, spending narrative, suspicious-charge
  judgment) wait on it.
- **Over-the-air refinements.** The rule feed is shipped (see "Over-the-air rule
  updates" above). What is deferred: **periodic polling on a timer** (rule updates
  are infrequent, so startup-once plus the manual button is enough); **auth-header
  support** for private-repo feeds (public raw URLs work today); and **feed
  signature verification**, deferred until rules are distributed beyond a trusted
  first-party URL.
- **Deeper data products.** Rules needing Plaid **Liabilities** (card APR and
  interest projection, payment-due, student-loan and mortgage tracking) — the
  account is entitled, but Liabilities is not yet ingested. **Income** rules need a
  Plaid product request that has not been granted; paycheck detection is instead
  approximated from recurring inflows.
- **Guardian / Navigator execution.** Automated action on a finding; connections
  remain read-only. (The **Advisor** tier — drafting a document for the user to
  review and send themselves — is now shipped; see "Actions and the trust ladder".)
- **Delivery tiers.** The two-tier digest/push split and deadline-forced surfacing
  from the ranking section; today it is a single suppression floor plus
  fresh-since-last-run delivery.
