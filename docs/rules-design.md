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

- **A rule is metadata; detection is a registry.** A stored rule is normalized
  metadata (a `kind`, a domain, an action tier, a schedule) — not a query program.
  The detection logic for each `kind` lives in one registered evaluator that
  shares a single contract with all the others. Adding a rule kind means
  registering one evaluator; the ranking, delivery, and action pipeline is
  untouched. Built-in and custom rules run through the same registry.
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

## A rule record and its evaluator

A stored rule (`RuleRecord`) is normalized metadata, stored once, not duplicated
per execution level:

- `id`, `kind` — `kind` selects the evaluator in the registry.
- `domain` — for grouping in the UI only (see taxonomy below).
- `executionClass` — the capability the evaluator requires: `D` / `L` / `L+`.
- `actionTier` — the highest tier this rule may act at, subject to user grant.
- `scope`, `cadence`, `channel`, `scheduledHour`, `scheduledDay` — delivery
  metadata (`scheduledDay` is the weekday for weekly rules, day of month for
  monthly).

Each evaluator in the registry declares its `domain`, `executionClass`, default
action tier, keywords for natural-language inference, and any user facts it
requires. Given the connected-account data plus known facts, it returns zero or
more `Finding` drafts, which the engine finalizes into the finding contract.

Evaluation is tri-state. If a required fact has no value yet, the evaluator does
not fail and does not fire — the engine emits a **question** instead (see facts).
Evaluators marked always-on run even with no stored rule, so core safety findings
(connection health, cash drag, low balance) appear out of the box; the rest
require an enabled rule of their kind.

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
- `severity` — derived from the score unless the evaluator sets it explicitly.
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

A single suppression floor drops findings below it, **unless** the evaluator set
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

Today detection and the tier/confidence capping are implemented, and financial
connections stay read-only; Advisor artifact generation and Guardian/Navigator
execution are modeled in the contract but not yet wired to act.

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

## Shipped evaluators

All current evaluators are `D` (deterministic) over the connected-account stream
plus shipped reference data — no user input except where noted:

- **Cash flow** — idle cash, low / negative balance, cash runway, employer 401(k)
  match (fact-gated).
- **Spending** — large transactions, duplicate charges, fees and interest,
  subscription price increases, recurring subscriptions, new recurring charges,
  discretionary category spikes.
- **Credit** — credit utilization.
- **Investments** — brokerage cash drag, portfolio concentration.
- **Connections** — connection health, stale account data.

Built-in and custom rules share the same registry contract and finding contract.

## Not yet built

- **`L` / `L+` execution.** Every evaluator is `D` today. The language-model path
  — deterministic prefilter then model admit/reject/summarize, with a
  deterministic fallback — and the router that maps execution class to a physical
  engine (local model, remote model, query engine) are not implemented. Pure-LLM
  summaries (weekly digest, spending narrative, suspicious-charge judgment) wait on
  this.
- **Deeper data products.** Rules needing Plaid **Liabilities** (card APR and
  interest projection, payment-due, student-loan and mortgage tracking) — the
  account is entitled, but Liabilities is not yet ingested. **Income** rules need a
  Plaid product request that has not been granted; paycheck detection is instead
  approximated from recurring inflows.
- **Action execution.** Advisor artifact generation and Guardian/Navigator
  automated action; connections remain read-only.
- **Delivery tiers.** The two-tier digest/push split and deadline-forced surfacing
  from the ranking section; today it is a single suppression floor plus
  fresh-since-last-run delivery.
