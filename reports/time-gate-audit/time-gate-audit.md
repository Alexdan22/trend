# London/New York Time-Gate Production Audit

Generated: 2026-07-19T20:03:37.066Z
Audit period: 2026-07-07T14:20:03.000Z to 2026-07-19T20:02:53.000Z
IST period: 2026-07-07 19:50:03.000 IST to 2026-07-20 01:32:53.000 IST
Deployed commit: `faf70026e6977d8b93990763b181ddbaf0aec74b`

## Executive finding

The gate was enforced correctly for all 24 live and 24 shadow records opened in the audit period: 0 live-outside-window violations and 0 shadow-inside-window violations. 1 record-level integrity issue(s) need attention.

Live produced $129.27 (17/7/0, PF 2.58, expectancy $5.39), versus shadow -$60.30 (10/14/0, PF 0.63, expectancy -$2.51). Excluded shadow trades would not have increased the simple combined net result by -$60.30, before execution-cost and capacity effects. With only 24 live and 24 completed shadow trades, that comparison is weak evidence, not a basis for an immediate production change.

Recommendation: **RETAIN_AND_OBSERVE_LONGER** -- Retain the current production window provisionally and observe longer; do not revise it from this P&L sample alone. Separately settle the semantic specification: if the policy truly means the full London plus New York sessions, the fixed window will need a DST-aware revision.

## Deployment boundary and effective configuration

- Commit creation: 2026-06-28T22:56:42+05:30 (not treated as deployment).
- Commit reached the VPS by fast-forward pull at 2026-06-28T17:27:23.000Z (2026-06-28 22:57:23.000 IST).
- The prior PM2 process was stopped at 2026-07-07T14:17:32Z; the first retained start of the gated `pullback` process was 2026-07-07T14:20:03.000Z.
- The startup gate marker precedes the first following timestamped connection line at 2026-07-07T14:20:18.909Z; the resulting operational boundary uncertainty is 15.909 seconds.
- Production HEAD matches `faf70026e6977d8b93990763b181ddbaf0aec74b`, branch is `main`, and the production worktree was clean.
- Effective gate: enabled, inclusive 13:30-23:59 IST, fixed UTC offset +330 minutes, NY label threshold 18:30 IST.
- No gate override was defined in PM2 or .env; code defaults were effective.

The code classifies by shifting each UTC instant by +330 minutes and comparing the IST minute-of-day. The same conversion was used for this audit. Seconds within 23:59 remain allowed because the comparison is minute-granular and inclusive.

## Records and integrity

| Collection | Bounded-query matches | Opened in period | Completed | Open at snapshot | Gate violations | Record issues |
|---|---:|---:|---:|---:|---:|---:|
| trades | 24 | 24 | 24 | 0 | 0 | 1 |
| shadow_trades | 24 | 24 | 24 | 0 | 0 | 0 |

Duplicate trade IDs: live 0, shadow 0. Same-collection duplicate fingerprints: live 0, shadow 0; cross-collection candidates 0. Neither collection has a unique `tradeId` index, so this clean result relies on the application upsert key rather than database enforcement.

All 24 database shadow records had a retained creation-log ID, and 0 bounded creation-log IDs were missing from the database.

One live partial-close flag is not validated by its required fields. `pair-1783516501929` was a full STOP_LOSS (-$15.68, R -1.00). Logs show the stop-loss close overlapping position sync: sync saw the partial ticket disappear, set `partialClosed=true`, and finalized the pair without recording partial price/time/P&L or activating breakeven. This overstates the stored live partial frequency by one but does not alter that trade's internally consistent full-stop P&L/R.

Metadata coverage: live entry reason 100.0%, score 100.0%, category 0.0%, realized R 100.0%; shadow entry reason 100.0%, score 100.0%, category 0.0%, realized R 100.0%. Live records do not store explicit `executionMode` or `sessionLabel`; their classification is inferred from collection plus timestamp.

## Performance comparison

| Mode | Records | Complete | W/L/BE | Win rate | Net P&L | PF | Expectancy | Max DD | Avg win | Avg loss | Payoff | Avg duration | Avg realized R (coverage) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| LIVE | 24 | 24 | 17/7/0 | 70.8% | $129.27 | 2.58 | $5.39 | $41.99 | $12.43 | -$11.71 | 1.06 | 48.7 min | 0.54 (24/24) |
| SHADOW | 24 | 24 | 10/14/0 | 41.7% | -$60.30 | 0.63 | -$2.51 | $106.49 | $10.35 | -$11.70 | 0.88 | 49.1 min | -0.19 (24/24) |

Live recorded partial flags: 18/24 (75.0%); validated partial closes: 17/24 (70.8%); breakeven exits: 5/24 (20.8%); zero-P&L outcomes: 0/24. Shadow recorded/validated partial closes: 10/24 (41.7%); breakeven exits: 6/24 (25.0%); zero-P&L outcomes: 0/24. A BREAK_EVEN exit can still be a P&L win after a profitable partial close, so both rates are shown.

### By IST entry hour

| Mode | Bucket | N | W/L/BE | Net P&L | PF | Expectancy |
|---|---|---:|---:|---:|---:|---:|
| LIVE | 14 | 2 | 1/1/0 | $7.47 | 1.80 | $3.74 |
| LIVE | 15 | 3 | 2/1/0 | $18.17 | 2.72 | $6.06 |
| LIVE | 16 | 2 | 1/1/0 | -$1.66 | 0.73 | -$0.83 |
| LIVE | 17 | 4 | 3/1/0 | $8.72 | 1.54 | $2.18 |
| LIVE | 18 | 3 | 1/2/0 | -$10.24 | 0.68 | -$3.41 |
| LIVE | 19 | 3 | 3/0/0 | $50.47 | INF | $16.82 |
| LIVE | 20 | 1 | 1/0/0 | $7.15 | INF | $7.15 |
| LIVE | 21 | 3 | 3/0/0 | $35.59 | INF | $11.86 |
| LIVE | 22 | 1 | 0/1/0 | -$8.31 | 0.00 | -$8.31 |
| LIVE | 23 | 2 | 2/0/0 | $21.91 | INF | $10.96 |
| SHADOW | 00 | 1 | 1/0/0 | $6.71 | INF | $6.71 |
| SHADOW | 01 | 2 | 1/1/0 | -$8.71 | 0.46 | -$4.35 |
| SHADOW | 03 | 3 | 2/1/0 | -$0.83 | 0.93 | -$0.28 |
| SHADOW | 04 | 1 | 0/1/0 | -$6.02 | 0.00 | -$6.02 |
| SHADOW | 05 | 3 | 0/3/0 | -$33.00 | 0.00 | -$11.00 |
| SHADOW | 06 | 3 | 1/2/0 | -$24.03 | 0.22 | -$8.01 |
| SHADOW | 08 | 3 | 1/2/0 | -$6.60 | 0.75 | -$2.20 |
| SHADOW | 09 | 2 | 1/1/0 | $15.52 | 3.25 | $7.76 |
| SHADOW | 10 | 1 | 0/1/0 | -$8.52 | 0.00 | -$8.52 |
| SHADOW | 11 | 1 | 0/1/0 | -$11.92 | 0.00 | -$11.92 |
| SHADOW | 12 | 3 | 2/1/0 | $11.46 | 1.94 | $3.82 |
| SHADOW | 13 | 1 | 1/0/0 | $5.63 | INF | $5.63 |

### By inferred session label

| Mode | Bucket | N | W/L/BE | Net P&L | PF | Expectancy |
|---|---|---:|---:|---:|---:|---:|
| LIVE | LONDON_WINDOW | 12 | 7/5/0 | $16.70 | 1.29 | $1.39 |
| LIVE | NY_WINDOW | 12 | 10/2/0 | $112.56 | 5.69 | $9.38 |
| SHADOW | PRE_LONDON_WINDOW | 24 | 10/14/0 | -$60.30 | 0.63 | -$2.51 |

### By side

| Mode | Bucket | N | W/L/BE | Net P&L | PF | Expectancy |
|---|---|---:|---:|---:|---:|---:|
| LIVE | BUY | 1 | 1/0/0 | $21.44 | INF | $21.44 |
| LIVE | SELL | 23 | 16/7/0 | $107.83 | 2.32 | $4.69 |
| SHADOW | BUY | 2 | 0/2/0 | -$13.45 | 0.00 | -$6.72 |
| SHADOW | SELL | 22 | 10/12/0 | -$46.85 | 0.69 | -$2.13 |

### By entry reason

| Mode | Bucket | N | W/L/BE | Net P&L | PF | Expectancy |
|---|---|---:|---:|---:|---:|---:|
| LIVE | BEHAVIORAL_AND_SCORE | 3 | 2/1/0 | $18.92 | 4.12 | $6.31 |
| LIVE | SCORE | 21 | 15/6/0 | $110.35 | 2.45 | $5.25 |
| SHADOW | BEHAVIORAL_AND_SCORE | 4 | 2/2/0 | $0.14 | 1.00 | $0.03 |
| SHADOW | SCORE | 20 | 8/12/0 | -$60.43 | 0.55 | -$3.02 |

### By exit reason

| Mode | Bucket | N | W/L/BE | Net P&L | PF | Expectancy |
|---|---|---:|---:|---:|---:|---:|
| LIVE | BREAK_EVEN | 5 | 5/0/0 | $32.97 | INF | $6.59 |
| LIVE | STOP_LOSS | 8 | 1/7/0 | -$74.83 | 0.09 | -$9.35 |
| LIVE | TP_HIT | 11 | 11/0/0 | $171.14 | INF | $15.56 |
| SHADOW | BREAK_EVEN | 6 | 6/0/0 | $37.19 | INF | $6.20 |
| SHADOW | STOP_LOSS | 14 | 0/14/0 | -$163.83 | 0.00 | -$11.70 |
| SHADOW | TP_HIT | 4 | 4/0/0 | $66.35 | INF | $16.59 |

### By IST day

| Mode | Bucket | N | W/L/BE | Net P&L | PF | Expectancy |
|---|---|---:|---:|---:|---:|---:|
| LIVE | 2026-07-07 | 1 | 1/0/0 | $8.21 | INF | $8.21 |
| LIVE | 2026-07-08 | 4 | 2/2/0 | -$0.04 | 1.00 | -$0.01 |
| LIVE | 2026-07-09 | 2 | 2/0/0 | $25.86 | INF | $12.93 |
| LIVE | 2026-07-13 | 5 | 5/0/0 | $70.76 | INF | $14.15 |
| LIVE | 2026-07-14 | 2 | 0/2/0 | -$26.55 | 0.00 | -$13.27 |
| LIVE | 2026-07-15 | 3 | 1/2/0 | -$3.95 | 0.74 | -$1.32 |
| LIVE | 2026-07-16 | 4 | 3/1/0 | $18.17 | 3.19 | $4.54 |
| LIVE | 2026-07-17 | 3 | 3/0/0 | $36.81 | INF | $12.27 |
| SHADOW | 2026-07-08 | 5 | 1/4/0 | -$45.05 | 0.13 | -$9.01 |
| SHADOW | 2026-07-09 | 2 | 1/1/0 | $4.61 | 1.30 | $2.31 |
| SHADOW | 2026-07-13 | 1 | 0/1/0 | -$12.24 | 0.00 | -$12.24 |
| SHADOW | 2026-07-14 | 5 | 2/3/0 | -$28.86 | 0.34 | -$5.77 |
| SHADOW | 2026-07-15 | 2 | 1/1/0 | $7.31 | 1.86 | $3.65 |
| SHADOW | 2026-07-16 | 4 | 0/4/0 | -$32.26 | 0.00 | -$8.07 |
| SHADOW | 2026-07-17 | 5 | 5/0/0 | $46.19 | INF | $9.24 |

## PM2/log correlation

PM2 lifecycle evidence in the audit range contains 4 starts, 3 exits, and 2 explicit stops for `pullback`. One exit was SIGABRT (2026-07-11); later restarts were followed by synchronization markers. The current process snapshot was online from 2026-07-13T04:13:45.586Z with PM2 restart counter 2.

Retained post-gate output contains 24 shadow creation markers, 24 shadow finalizations, 10 partial/BE activations, 0 shadow restore batches, 0 shadow tick-processing errors, 0 live snapshot save failures, 5 entry-lock blocks, and 0 forced lock timeouts. Entry-lock logs show 49 acquisitions and 49 releases. There were 0 incomplete shadow records at the database snapshot.

There were 8 logged illegal ACTIVE-to-CLOSED transition warnings across 6 audited live trades. The finalization routine continued and each has one complete trade record, but the warning shows lifecycle validation was bypassed on sync-driven closure paths. No live or shadow trade interval crossed a timestamped PM2 lifecycle event.

The unusually high 586 session markers, 556 websocket-disconnect messages, and 66 reconnect mentions show repeated initialization/reconnect activity. Nevertheless, database/log ID reconciliation, zero duplicate IDs/fingerprints, zero shadow processing errors, and zero incomplete shadow records do not show duplicated or lost shadow records. Five entry-lock blocks occurred, but no forced lock timeout occurred; those are unpersisted attempted entries and cannot be proven unique from the untimestamped logs. Because most application lines have no timestamp, counts after the first gate marker are reliable through the stated log snapshot, while exact correlation is limited to timestamped MetaAPI and PM2 lifecycle lines.

## London/New York and daylight saving

The fixed 13:30-23:59 IST window does **not** accurately represent the full union of conventional London and New York sessions year-round. During this July audit, London 08:00-17:00 BST maps to 12:30-21:30 IST and New York 08:00-17:00 EDT maps to 17:30-02:30 IST next day. The gate therefore misses the first London hour, labels the first New York hour as LONDON_WINDOW, and truncates New York after 23:59. In winter, 13:30 matches the London open and 18:30 matches the New York open, but the post-midnight New York session is still truncated. UK and US transition on different dates, so a fixed IST mapping also misaligns during transition weeks.

DST references: [UK government clock-change rules](https://www.gov.uk/when-do-the-clocks-change) and [US NIST daylight-saving rules](https://www.nist.gov/pml/time-and-frequency-division/popular-links/daylight-saving-time-dst). Session hours here are explicitly treated as conventional FX/spot-gold labels rather than exchange-enforced hours.

## Confirmed findings vs weak conclusions

Confirmed:

- 0 live trades opened outside the configured window.
- 0 shadow trades were created inside the configured window.
- 1 live record and 0 shadow records had integrity anomalies (4 individual checks).
- 0 shadow trades were incomplete at the snapshot.
- Shadow trades would not have improved simple aggregate net P&L before execution/capacity effects.

Weak because of sample size or simulation limits:

- Only 24 live and 24 shadow completed trades were available.
- Live expectancy was higher than shadow expectancy, but this sample is too small for a durable signal-quality conclusion.
- Session/hour/day subgroup results are particularly fragile because several buckets contain only one or a few trades.

## Record manifest

Every in-period record is listed below. Times show both stored UTC instant and the audit's +05:30 IST conversion.

| Mode | Trade ID | Opened UTC | Opened IST | Session | Side | Entry | Exit | Result | Net | Complete | Issues |
|---|---|---|---|---|---|---|---|---|---:|---|---|
| LIVE | `pair-1783448704953` | 2026-07-07T18:25:05.321Z | 2026-07-07 23:55:05.321 IST | NY_WINDOW | SELL | SCORE | TP_HIT | WIN | $8.21 | YES | None |
| LIVE | `pair-1783510202297` | 2026-07-08T11:30:02.855Z | 2026-07-08 17:00:02.855 IST | LONDON_WINDOW | SELL | BEHAVIORAL_AND_SCORE | BREAK_EVEN | WIN | $7.12 | YES | None |
| LIVE | `pair-1783513501539` | 2026-07-08T12:25:01.978Z | 2026-07-08 17:55:01.978 IST | LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$16.00 | YES | None |
| LIVE | `pair-1783516501929` | 2026-07-08T13:15:03.027Z | 2026-07-08 18:45:03.027 IST | NY_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$15.68 | YES | partialClosed but partialExitPrice is missing; partialClosed but partialClosedAt is missing; partialClosed but partialPnL is missing; partialClosed but breakEvenActive is false |
| LIVE | `pair-1783519502059` | 2026-07-08T14:05:03.030Z | 2026-07-08 19:35:03.030 IST | NY_WINDOW | SELL | SCORE | TP_HIT | WIN | $24.53 | YES | None |
| LIVE | `pair-1783596004344` | 2026-07-09T11:20:04.839Z | 2026-07-09 16:50:04.839 IST | LONDON_WINDOW | SELL | SCORE | BREAK_EVEN | WIN | $4.42 | YES | None |
| LIVE | `pair-1783602601535` | 2026-07-09T13:10:01.892Z | 2026-07-09 18:40:01.892 IST | NY_WINDOW | BUY | SCORE | TP_HIT | WIN | $21.44 | YES | None |
| LIVE | `pair-1783931401824` | 2026-07-13T08:30:02.454Z | 2026-07-13 14:00:02.454 IST | LONDON_WINDOW | SELL | SCORE | TP_HIT | WIN | $16.84 | YES | None |
| LIVE | `pair-1783943402623` | 2026-07-13T11:50:02.987Z | 2026-07-13 17:20:02.987 IST | LONDON_WINDOW | SELL | SCORE | BREAK_EVEN | WIN | $5.81 | YES | None |
| LIVE | `pair-1783949703379` | 2026-07-13T13:35:03.746Z | 2026-07-13 19:05:03.746 IST | NY_WINDOW | SELL | BEHAVIORAL_AND_SCORE | TP_HIT | WIN | $17.88 | YES | None |
| LIVE | `pair-1783959600423` | 2026-07-13T16:20:00.832Z | 2026-07-13 21:50:00.832 IST | NY_WINDOW | SELL | SCORE | TP_HIT | WIN | $16.54 | YES | None |
| LIVE | `pair-1783964112816` | 2026-07-13T17:35:13.186Z | 2026-07-13 23:05:13.186 IST | NY_WINDOW | SELL | SCORE | TP_HIT | WIN | $13.70 | YES | None |
| LIVE | `pair-1784023502547` | 2026-07-14T10:05:03.028Z | 2026-07-14 15:35:03.028 IST | LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$10.55 | YES | None |
| LIVE | `pair-1784033702119` | 2026-07-14T12:55:02.993Z | 2026-07-14 18:25:02.993 IST | LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$16.00 | YES | None |
| LIVE | `pair-1784106903014` | 2026-07-15T09:15:03.573Z | 2026-07-15 14:45:03.573 IST | LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$9.37 | YES | None |
| LIVE | `pair-1784112602561` | 2026-07-15T10:50:03.112Z | 2026-07-15 16:20:03.112 IST | LONDON_WINDOW | SELL | BEHAVIORAL_AND_SCORE | STOP_LOSS | LOSS | -$6.07 | YES | None |
| LIVE | `pair-1784131201056` | 2026-07-15T16:00:01.668Z | 2026-07-15 21:30:01.668 IST | NY_WINDOW | SELL | SCORE | TP_HIT | WIN | $11.49 | YES | None |
| LIVE | `pair-1784196003222` | 2026-07-16T10:00:03.703Z | 2026-07-16 15:30:03.703 IST | LONDON_WINDOW | SELL | SCORE | TP_HIT | WIN | $11.27 | YES | None |
| LIVE | `pair-1784208901541` | 2026-07-16T13:35:01.966Z | 2026-07-16 19:05:01.966 IST | NY_WINDOW | SELL | SCORE | BREAK_EVEN | WIN | $8.07 | YES | None |
| LIVE | `pair-1784213401358` | 2026-07-16T14:50:01.963Z | 2026-07-16 20:20:01.963 IST | NY_WINDOW | SELL | SCORE | STOP_LOSS | WIN | $7.15 | YES | None |
| LIVE | `pair-1784220005579` | 2026-07-16T16:40:06.087Z | 2026-07-16 22:10:06.087 IST | NY_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$8.31 | YES | None |
| LIVE | `pair-1784280903369` | 2026-07-17T09:35:03.846Z | 2026-07-17 15:05:03.846 IST | LONDON_WINDOW | SELL | SCORE | TP_HIT | WIN | $17.45 | YES | None |
| LIVE | `pair-1784289901012` | 2026-07-17T12:05:01.499Z | 2026-07-17 17:35:01.499 IST | LONDON_WINDOW | SELL | SCORE | TP_HIT | WIN | $11.80 | YES | None |
| LIVE | `pair-1784304006211` | 2026-07-17T16:00:06.696Z | 2026-07-17 21:30:06.696 IST | NY_WINDOW | SELL | SCORE | BREAK_EVEN | WIN | $7.56 | YES | None |
| SHADOW | `shadow-1783453500832` | 2026-07-07T19:45:00.523Z | 2026-07-08 01:15:00.523 IST | PRE_LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$16.00 | YES | None |
| SHADOW | `shadow-1783462200458` | 2026-07-07T22:10:00.108Z | 2026-07-08 03:40:00.108 IST | PRE_LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$11.99 | YES | None |
| SHADOW | `shadow-1783469402522` | 2026-07-08T00:10:02.161Z | 2026-07-08 05:40:02.161 IST | PRE_LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$11.32 | YES | None |
| SHADOW | `shadow-1783472102485` | 2026-07-08T00:55:02.202Z | 2026-07-08 06:25:02.202 IST | PRE_LONDON_WINDOW | SELL | SCORE | BREAK_EVEN | WIN | $6.70 | YES | None |
| SHADOW | `shadow-1783479002442` | 2026-07-08T02:50:02.188Z | 2026-07-08 08:20:02.188 IST | PRE_LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$12.44 | YES | None |
| SHADOW | `shadow-1783558500395` | 2026-07-09T00:55:00.133Z | 2026-07-09 06:25:00.133 IST | PRE_LONDON_WINDOW | SELL | BEHAVIORAL_AND_SCORE | STOP_LOSS | LOSS | -$15.32 | YES | None |
| SHADOW | `shadow-1783564502023` | 2026-07-09T02:35:01.839Z | 2026-07-09 08:05:01.839 IST | PRE_LONDON_WINDOW | SELL | SCORE | TP_HIT | WIN | $19.93 | YES | None |
| SHADOW | `shadow-1783926902857` | 2026-07-13T07:15:02.397Z | 2026-07-13 12:45:02.397 IST | PRE_LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$12.24 | YES | None |
| SHADOW | `shadow-1783969801677` | 2026-07-13T19:10:01.277Z | 2026-07-14 00:40:01.277 IST | PRE_LONDON_WINDOW | SELL | SCORE | BREAK_EVEN | WIN | $6.71 | YES | None |
| SHADOW | `shadow-1783981801373` | 2026-07-13T22:29:58.111Z | 2026-07-14 03:59:58.111 IST | PRE_LONDON_WINDOW | SELL | SCORE | TP_HIT | WIN | $8.17 | YES | None |
| SHADOW | `shadow-1783988401777` | 2026-07-14T00:20:01.506Z | 2026-07-14 05:50:01.506 IST | PRE_LONDON_WINDOW | SELL | BEHAVIORAL_AND_SCORE | STOP_LOSS | LOSS | -$14.25 | YES | None |
| SHADOW | `shadow-1783991701270` | 2026-07-14T01:15:00.495Z | 2026-07-14 06:45:00.495 IST | PRE_LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$15.40 | YES | None |
| SHADOW | `shadow-1783997102776` | 2026-07-14T02:45:02.510Z | 2026-07-14 08:15:02.510 IST | PRE_LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$14.09 | YES | None |
| SHADOW | `shadow-1784092502398` | 2026-07-15T05:15:02.171Z | 2026-07-15 10:45:02.171 IST | PRE_LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$8.52 | YES | None |
| SHADOW | `shadow-1784099400984` | 2026-07-15T07:10:00.419Z | 2026-07-15 12:40:00.419 IST | PRE_LONDON_WINDOW | SELL | SCORE | TP_HIT | WIN | $15.82 | YES | None |
| SHADOW | `shadow-1784156702512` | 2026-07-15T23:05:02.300Z | 2026-07-16 04:35:02.300 IST | PRE_LONDON_WINDOW | BUY | SCORE | STOP_LOSS | LOSS | -$6.02 | YES | None |
| SHADOW | `shadow-1784161502375` | 2026-07-16T00:25:02.088Z | 2026-07-16 05:55:02.088 IST | PRE_LONDON_WINDOW | BUY | SCORE | STOP_LOSS | LOSS | -$7.43 | YES | None |
| SHADOW | `shadow-1784174702600` | 2026-07-16T04:05:02.378Z | 2026-07-16 09:35:02.378 IST | PRE_LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$6.89 | YES | None |
| SHADOW | `shadow-1784182802212` | 2026-07-16T06:20:01.950Z | 2026-07-16 11:50:01.950 IST | PRE_LONDON_WINDOW | SELL | SCORE | STOP_LOSS | LOSS | -$11.92 | YES | None |
| SHADOW | `shadow-1784230200817` | 2026-07-16T19:30:00.314Z | 2026-07-17 01:00:00.314 IST | PRE_LONDON_WINDOW | SELL | BEHAVIORAL_AND_SCORE | BREAK_EVEN | WIN | $7.29 | YES | None |
| SHADOW | `shadow-1784240100519` | 2026-07-16T22:15:00.289Z | 2026-07-17 03:45:00.289 IST | PRE_LONDON_WINDOW | SELL | SCORE | BREAK_EVEN | WIN | $2.98 | YES | None |
| SHADOW | `shadow-1784260502051` | 2026-07-17T03:55:01.787Z | 2026-07-17 09:25:01.787 IST | PRE_LONDON_WINDOW | SELL | BEHAVIORAL_AND_SCORE | TP_HIT | WIN | $22.41 | YES | None |
| SHADOW | `shadow-1784270401864` | 2026-07-17T06:40:01.503Z | 2026-07-17 12:10:01.503 IST | PRE_LONDON_WINDOW | SELL | SCORE | BREAK_EVEN | WIN | $7.88 | YES | None |
| SHADOW | `shadow-1784274602368` | 2026-07-17T07:50:02.100Z | 2026-07-17 13:20:02.100 IST | PRE_LONDON_WINDOW | SELL | SCORE | BREAK_EVEN | WIN | $5.63 | YES | None |

## Method, reproducibility, and limitations

The collector uses only bounded MongoDB `find` queries across `openedAt`, `createdAt`, `updatedAt`, and `closedAt`, lists indexes, reads Git/PM2 metadata and retained logs, and excludes account/user IDs and all secret environment values. The production strategy module is never imported. Re-run the command in the source header with the pinned bounds for the same database scope; later record updates or log rotation can change results.

- Application PM2 output lines generally lack timestamps, so only PM2 lifecycle rows and timestamped MetaAPI lines support exact event times.
- Live grossPnL and netPnL are identical in the stored snapshots; commissions, swaps, and slippage are therefore not separately represented.
- Shadow fills are tick-simulated and do not include live order rejection, slippage, spread/cost, or capacity interactions.
- No independent broker statement was queried; this audit is of trades, shadow_trades, deployed code, and retained PM2 logs.

Production confirmation: no database write, service restart/reload, configuration change, live-position action, strategy change, or remote file write was performed. Only the local report artifacts were created.
