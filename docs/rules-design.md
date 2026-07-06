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

- **Rules are data, not code.** A rule definition is a row in the `rule_specs`
  table: metadata plus a **SQL query** (deterministic) or a prompt (LLM). Built-in
  rules ship as a seed loaded into that table on startup; new rules are added or
  changed as rows — no code, no redeploy. The engine is a generic interpreter that
  runs whatever specs the table holds, so built-in and downloaded rules are
  identical to it. (A future job can poll a versioned rule-definition file and
  upsert changed specs into the table.)
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

## A rule spec (definition) and a rule instance

A rule **definition** is a `RuleSpec` row in the `rule_specs` table:

- `kind` (primary key), `domain`, `executionClass` (`D` / `L` / `L+`),
  `actionTier`, `scope`, `cadence`.
- `alwaysOn` — runs even with no stored rule instance.
- `keywords` — a regex source string, for natural-language rule inference.
- `sql` — the deterministic query (a `D` rule); OR `prompt` — the LLM spec.
- `facts` — the user facts the rule needs (JSON).
- `enabled`, `version`, `source` (`builtin` | `downloaded`).

A user's saved rule **instance** is a `RuleRecord` in the `rules` table — a `kind`
plus its schedule (`cadence`, `channel`, `scheduledHour`, `scheduledDay`, and
`enabled`); it references a spec by `kind`. Built-in `alwaysOn` specs run without
any instance, so core safety findings (connection health, cash drag, low balance)
appear out of the box; opt-in rules run once the user has an enabled instance.

For a `D` spec the engine runs its `sql` through a read-only query runner (SQLite
stays behind the repository port). The query selects the finding-draft columns
(`title`, `detail`, `dollar_impact_minor`, `confidence`, `severity`, …) with a few
bound params (`:now_iso`, `:rule_created_at`, `:hysa_apr`, …); the engine maps each
row to a draft and finalizes it into the finding contract. Shared SQL primitives —
the UDFs `money()`, `normalize_merchant()`, `fee_like()`, the `median` aggregate,
and the `recurring_series` view — let even the gnarly recurring/temporal rules stay
pure SQL, so a downloaded rule can just `SELECT … FROM recurring_series`.

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

## Shipped rules

All current rules are `D` (deterministic) SQL specs over the connected-account
stream plus shipped reference data — no user input except where noted. They are
seeded into `rule_specs` on startup:

- **Cash flow** — idle cash, low / negative balance, cash runway, cash-flow
  negative, upcoming bills / overdraft, net-worth movement, employer 401(k) match
  (fact-gated).
- **Spending** — large transactions, duplicate charges, fees and interest,
  subscription price increases, recurring subscriptions, new recurring charges,
  discretionary category spikes, cross-card duplicate subscriptions, unfamiliar
  merchant charges.
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
- **Over-the-air delivery.** The repository can upsert specs, but the job that
  polls a versioned rule-definition file and downloads changed specs into
  `rule_specs` is not built; today built-ins are seeded from code on startup.
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
