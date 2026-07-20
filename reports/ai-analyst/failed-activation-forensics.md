# Independent AI Analyst failed-activation forensics

Generated from read-only production queries on 2026-07-20. Production commit: `f3cb22d98ae7d03376745acf4768dcfde4626991`. The analyst was confirmed `OFF`; no documents or indexes were changed.

## Scope and grouping

- Live replay: `signal-5333fa08-30b5-4660-90ec-cc3878d5474f` linked to `pair-1784304006211`.
- Shadow replay: `signal-5daa366b-9e26-4de5-816f-7182018d267d` linked to `shadow-1784517000948`.
- Activation write interval: 2026-07-20T06:47:53.649Z through 2026-07-20T06:49:29.227Z.
- Immutable artifacts: 24 total. Twenty-three hashes recompute correctly; one signal-event hash is mismatched.
- Operational documents: one usage-budget document was created and one pre-existing runtime document was updated.

## Live replay artifacts

| Collection | `_id` | Role/linkage | Canonical hash | Verification |
|---|---|---|---|---|
| `ai_signal_events` | `6a5dc499046b047f30b7a644` | SIGNAL root; `eventKey: null` | `4318237d722002e1d1efe8c158d73841bd064b91648f460a3980a1b0c4e5a1b0` | **MISMATCH**; recomputed `97683cf8704d40eda4b80889ce15ba5fc96f28926935744bcfdb93e96a592f5e` |
| `ai_market_snapshots` | `6a5dc499046b047f30b7a645` | SIGNAL `snapshot-b3637162-36fc-4a48-8d49-f0e1fb145f79` | `c6fa1858c89e02055952bb2bbb19d9634bbc729c9cd41e0ffaacbc040be88c78` | MATCH |
| `ai_market_charts` | `6a5dc499046b047f30b7a646` | SIGNAL M30, snapshot `b363…5f79` | `3a804b1768599da048bda3b3884492ea7da0481e73f896188a81f4a5040bac9f` | MATCH |
| `ai_market_charts` | `6a5dc499046b047f30b7a647` | SIGNAL M5, snapshot `b363…5f79` | `baaad6fcb0f1bf0c3e330895a40eed3669a819699ba5b1f2765fb6e860163846` | MATCH |
| `ai_market_charts` | `6a5dc499046b047f30b7a648` | SIGNAL M1, snapshot `b363…5f79` | `c2d71d969488f2635480296324ae48ed4a85f86decf18efc631ae20ee923ef37` | MATCH |
| `ai_analysis_runs` | `6a5dc4a0046b047f30b7a64a` | BLIND SUCCEEDED; `airun-d7e057ed-68cc-4341-ac62-ddb6be3846b5` | `2122c249506ec647b3f23f04129e201b82b96e1a03fbf69ab129a4a8dffcc80a` | MATCH |
| `ai_blind_assessments` | `6a5dc4a0046b047f30b7a64b` | Blind assessment for signal snapshot | `c96566e7ec362c02dca6f8697d99f2f68c19bdca988e01e13e9e7b0b775bc60f` | MATCH |
| `ai_signal_trade_links` | `6a5dc4a0046b047f30b7a64c` | Live trade link | `005f1961fa1d7845cdf8b19b8ae997d02fab96baaeed0d4d54217dc32f2be980` | MATCH |
| `ai_analysis_runs` | `6a5dc4a7046b047f30b7a64d` | COMPARISON SUCCEEDED; `airun-07431d38-c3fd-4061-b8dd-a57b5a64e924` | `c865183a93e440cffeeb7f75043712766974e7e5bb03204411cd7498b676e15b` | MATCH |
| `ai_signal_comparisons` | `6a5dc4a7046b047f30b7a64e` | Comparison linked to live trade | `aabdccbe089129cbda6d959428d72d2157c6471602e26fdd42c912a2a4de5491` | MATCH |
| `ai_market_snapshots` | `6a5dc4aa046b047f30b7a64f` | EXIT `snapshot-07e349a2-ff55-410d-a558-f325636866c7` | `1c716e6ee88e4e6ceda70a468c71170ddb7f9eb8ba28d78243a7a583597b0bed` | MATCH |
| `ai_market_charts` | `6a5dc4aa046b047f30b7a650` | EXIT M30, snapshot `07e3…66c7` | `e88b0bf9c7df0f89ad0ba0926cde450f7518fc07ea3e288634a3411875704521` | MATCH |
| `ai_market_charts` | `6a5dc4aa046b047f30b7a651` | EXIT M5, snapshot `07e3…66c7` | `fa88d094581bfbedeff4177b1651bb09bc48220771b86f76cf9a8f6ec31a861a` | MATCH |
| `ai_market_charts` | `6a5dc4aa046b047f30b7a652` | EXIT M1, snapshot `07e3…66c7` | `b21d83b95d3bd30914929eceefb4eb0da70d509f062b77ffe2812cea8408267a` | MATCH |
| `ai_analysis_runs` | `6a5dc4b0046b047f30b7a653` | OUTCOME SUCCEEDED; `airun-2fbe9d69-8e68-4b34-b9ee-ac5d75ab7228` | `40fb4be0f049b236b570b33664fd06a687d39af8dffcc16bdd3cff10c2d380f8` | MATCH |
| `ai_outcome_reviews` | `6a5dc4b0046b047f30b7a654` | Outcome linked to live exit snapshot | `2a7cf14384ab5636039273967d60744a8eb2a30e8f293cc4a1567025541bcb81` | MATCH |

The live chain is structurally complete, but its root signal event is invalid: JavaScript `undefined` was omitted from the hash and serialized by the MongoDB driver as BSON `null`. All descendants therefore derive from a root whose stored representation does not match its canonical hash.

## Shadow replay artifacts

| Collection | `_id` | Role/linkage | Canonical hash | Verification |
|---|---|---|---|---|
| `ai_analysis_runs` | `6a5dc4f64bbf904d5ab753c6` | SIGNAL PERSISTENCE_ERROR; `airun-40b1ec95-1486-4f99-b005-e23378946a05` | `8455abf4f82f6a921b847d57151e31a7e861f6cab4f507074ce38fb1c3961826` | MATCH |
| `ai_signal_trade_links` | `6a5dc4f64bbf904d5ab753c7` | Shadow trade link with no signal root | `ad302907153f4be6072243bbf06bdb5fa1e1787d2901b1d604ce34a4578a4a13` | MATCH; **ORPHAN** |
| `ai_analysis_runs` | `6a5dc4f64bbf904d5ab753c8` | COMPARISON PREREQUISITE_MISSING; `airun-5e402b0a-18a4-4272-881d-3932de7bec09` | `239f3399a4ea7fa6f2e95682f8c4be9c0c16bba5e42f130f7f0311e911651d9b` | MATCH |
| `ai_market_snapshots` | `6a5dc4f94bbf904d5ab753c9` | EXIT `snapshot-16f7e24f-2436-49ad-9578-c074d2449ef0`; no signal root | `bc76a31c5ed2ff8b8df60bf9602780222c34223c3079dd4762fd6febb762b1c9` | MATCH; **ORPHAN** |
| `ai_market_charts` | `6a5dc4f94bbf904d5ab753ca` | EXIT M30, snapshot `16f7…9ef0` | `4edaa82c91ba5211ad622170c3fde828ef25da658384e468244ec1f679d9504e` | MATCH; **ORPHAN** |
| `ai_market_charts` | `6a5dc4f94bbf904d5ab753cb` | EXIT M5, snapshot `16f7…9ef0` | `f9452e3f891bae565cfa41a5719b12e636b7777105b938f7e233b1c1422167df` | MATCH; **ORPHAN** |
| `ai_market_charts` | `6a5dc4f94bbf904d5ab753cc` | EXIT M1, snapshot `16f7…9ef0` | `1f2ec0af51ed5f4de5aaabc4c27a2b566afb13f7e8f498340509471a9e207279` | MATCH; **ORPHAN** |
| `ai_analysis_runs` | `6a5dc4f94bbf904d5ab753cd` | OUTCOME PREREQUISITE_MISSING; `airun-dfd41212-7fe3-400c-ac06-1049448a6326` | `f0341fe9c30358c781f13e5bd08c2c9569e54ba8a9f88bbb201faaa7b22c381c` | MATCH |

There is no `ai_signal_events`, blind-assessment, signal-comparison or outcome-review document for the shadow signal. Its link, exit snapshot and three charts are orphaned. The three run documents correctly record why the chain did not complete.

## Operational records

| Collection | `_id` | Finding | Cleanup disposition |
|---|---|---|---|
| `ai_usage_budgets` | `6a5dc499046b047f30b7a649` | Created by activation; 3 real API calls, 15,714 input tokens, 1,869 output tokens, cost `$0.020196` | Retain as truthful usage/cost accounting |
| `ai_analyst_runtime` | `6a5dbe8114e589df69550a74` | Pre-existing since 06:21:53Z; updated by warm-up/rate activity through 06:49:28Z | Retain; it is operational state, not an immutable analysis artifact |

Two automatic Telegram messages were delivered for the live replay. They are external side effects and are not part of MongoDB cleanup.

## Exact bounded cleanup proposal

The proposed cleanup removes all 24 immutable artifacts from both replay chains. Removing the complete live chain is necessary because its root hash is invalid and the stored trade link would otherwise suppress a clean replay. The operational usage-budget and runtime documents remain untouched.

### Backup

1. Require `AI_ANALYST_MODE=OFF` with signal/control/exit/Telegram flags false and legacy narrator false.
2. Before any validator or index change, create `/home/alex/secure-backups/ai-analyst-rollout/failed-activation-cleanup-<UTC>/` with mode `0700`.
3. Export the 24 complete immutable documents as canonical Extended JSON (`relaxed: false`), grouped by collection, plus full collection options and index definitions. Export the usage-budget and runtime documents to a separate read-only context file; they are not deletion targets.
4. Set files to mode `0600`, calculate SHA-256 hashes, write `SHA256SUMS`, parse every Extended JSON file back, and verify all `_id` values and document counts before deletion.

### Preconditions

- Exact per-collection immutable counts: signal events 1, links 2, snapshots 3, charts 9, blind assessments 1, comparisons 1, outcomes 1, analysis runs 6.
- The exact 24 `_id` values must match the tables above; no additional immutable AI documents may exist.
- Signal event `6a5dc499046b047f30b7a644` must have stored hash `431823…a1b0`, recomputed hash `97683c…2f5e`, and explicit `eventKey: null`.
- The other 23 immutable documents must recompute to their stored canonical hashes.
- The shadow chain must have zero signal-event, blind-assessment, comparison and outcome documents.
- `uniq_eventKey` must still be the legacy `{eventKey: 1}`, unique, sparse index. No cleanup is allowed after validator/index migration without a new rollback review.
- Usage budget `_id: 6a5dc499046b047f30b7a649` and runtime `_id: 6a5dbe8114e589df69550a74` must be backed up and excluded from every delete filter.

### Transactional deletion

Run one MongoDB transaction. For each immutable collection, issue one `deleteMany` whose filter is an `$or` of exact tuples containing `_id`, `canonicalHash`, `signalEventId`, and the collection-specific linkage field (`snapshotId`, `tradeId`, `runId`, stage or timeframe where applicable). Delete in this order: charts, outcome, comparison, blind assessment, snapshots, trade links, analysis runs, signal event.

Abort unless every `deletedCount` equals its expected count and the total equals exactly 24. Before commit, assert that all 24 `_id` values are absent, every immutable collection count is zero, and the usage-budget/runtime documents are byte-for-byte unchanged from the backup context. Commit only after those checks pass.

### Rollback

Rollback is valid only before any validator/index migration. In one transaction, parse the protected Extended JSON and `insertMany` the original documents with their original `_id` and BSON types. Reinsert by collection, assert 24 inserted documents, verify every `_id`, stored hash and expected mismatch state, confirm the legacy sparse index remains unchanged, and verify the operational documents were never modified. Abort the rollback on any duplicate, validation, count or hash discrepancy.

## Approval boundary

No backup, deletion, validator update, index replacement, deployment, restart or AI reactivation was performed during this forensic review.
