# HANDOFF_SALES_V2

## Scope

This handoff reflects the current working tree after Bloc 3B implementation and focused validation.

- Bloc 1 remains validated and green.
- Bloc 2 is implemented and validated.
- Bloc 3A is implemented and validated.
- Bloc 3B is implemented.

## Bloc 3B architecture

Bloc 3B adds an additive basket/loading layer on top of the already validated Sales V2 executable plan.

The validated Smart Portfolio visit-selection semantics are unchanged:

- portfolio control remains independent from basket prediction
- assignment semantics remain independent from basket prediction
- automatic readiness / rebuild behavior from Bloc 3A is unchanged

Backend basket/loading flow:

1. `optimisation_tournee_api/next_best_visit_service.js`
   - preserves product-level model baskets when the prediction payload already contains them
   - adds a bounded sales-history query for planned clients only:
     - `entetecommercials`
     - `lignecommercials`
     - `produits`
   - builds deterministic historical fallback baskets only when model products are absent
   - aggregates per-block loading as:
     - commercial
     - planning date
     - product

2. product recommendation source policy
   - `model`
     - only when a real product basket is already present in the prediction payload
   - `historical_pattern`
     - deterministic fallback from real client/product purchase history
   - `unavailable`
     - no product invented when history is insufficient

3. frontend rendering
   - `optimisation_tournee_front/src/SalesTourDetails.jsx`
     - now renders:
       - `Panier estime`
       - `Chargement estime`
   - `optimisation_tournee_front/src/SalesBasketPrediction.jsx`
     - compact per-client basket detail
   - `optimisation_tournee_front/src/SalesLoadingPrediction.jsx`
     - per-block loading estimate with honest labels and coverage
   - main visit table remains compact and does not list every product inline

## Bloc 3B files changed

Backend:

- `optimisation_tournee_api/next_best_visit_service.js`
- `optimisation_tournee_api/tests/next_best_visit_basket_loading.test.cjs`

Frontend:

- `optimisation_tournee_front/src/SalesTourDetails.jsx`
- `optimisation_tournee_front/src/SalesLoadingPrediction.jsx`
- `optimisation_tournee_front/src/SalesBasketPrediction.jsx`
- `optimisation_tournee_front/src/SalesCoveragePlanner.css`
- `optimisation_tournee_front/src/salesCoverageDetails.js`
- `optimisation_tournee_front/src/__tests__/salesCoverageDetails.test.mjs`

Handoff:

- `HANDOFF_SALES_V2.md`

## Actual product data sources found

Real product-level source data available in the current tree:

- sales documents from `entetecommercials`
- sales lines from `lignecommercials`
- product metadata from `produits`

Product-level model status found:

- a real product-level basket exists in the older dashboard prediction path
  - Python-side dashboard output can build `details`
  - `coverage_purchase_prediction_profiles.js` already knows how to normalize that basket

- the current Sales V2 batch prediction path does NOT currently expose a reliable product-level basket by default
  - therefore Bloc 3B does not assume model baskets are always available
  - it preserves them if present
  - otherwise it falls back to deterministic client history

## Fallback logic

Historical fallback is intentionally simple and explainable:

1. load product purchase history only for already planned clients
2. aggregate real client/product purchase history by document and date
3. recommend products only when at least one of these is true:
   - product purchased in at least 2 distinct documents
   - product purchased recently within the configured recency window
4. estimated quantity:
   - repeated product => average quantity per document
   - recent single product => last observed quantity
5. if no product passes those checks:
   - basket source = `unavailable`
   - no product is invented

Explicitly not done:

- no global-popularity fallback
- no invented product labels
- no invented packaging rule
- no arbitrary safety margin

## Basket API structure

Per planned client, the response now carries:

- `recommended_products`
- `predicted_products`
  - preserved as a backward-compatible alias
- `basket_prediction_source`

Current basket item shape:

- `product_id`
- `product_code`
- `product_label`
- `estimated_quantity`
- `prediction_source`
- `confidence_or_support`

Rules:

- exact product codes are preserved as strings
- exact client codes are preserved as strings
- `null` remains `null`
- unavailable basket data is never shown as `0`

## Loading aggregation structure

Per executable block, the response now carries:

- `loading_prediction`

Current loading shape:

- `commercial_code`
- `planning_date`
- `products`
  - `product_id`
  - `product_code`
  - `product_label`
  - `estimated_need`
  - `recommended_load_quantity`
  - `prediction_source`
  - `confidence_or_support`
- `coverage`
  - `planned_visits`
  - `visits_with_basket_prediction`
  - `basket_prediction_coverage_pct`

## Quantity semantics

Bloc 2 quantity honesty remains preserved.

For basket items:

- `estimated_quantity`
  - model quantity only when a real model basket is present
  - otherwise deterministic historical estimate
  - otherwise unavailable

For loading:

- `recommended_load_quantity = estimated_need`
  - no extra safety margin is added
  - loading remains an estimate, not an optimization result

No carton/pack rounding was introduced because no reliable packaging rule was validated in the inspected path.

## UI behavior

Sales V2 executable-plan details now show:

- `Panier estime`
  - per client
  - compact card layout
  - `Panier : Non disponible` when unsupported

- `Chargement estime`
  - grouped for the selected date + commercial block
  - shows:
    - produit
    - besoin estime
    - source
    - support/confidence when meaningful
    - basket coverage

Honest labels now used:

- `Panier estime`
- `Besoin estime`
- `Chargement estime`
- `Base sur le modele`
- `Base sur l historique client`
- `Non disponible`

The route map remains a route/execution visualization only.

## Focused Bloc 3B tests executed and results

Focused tests were run and passed before the final regression pass:

1. `node --test optimisation_tournee_api/tests/next_best_visit_basket_loading.test.cjs`
   - PASS
   - 4/4 tests passed
   - 0 failed

2. `node --test src/__tests__/salesCoverageDetails.test.mjs`
   - PASS
   - 30/30 tests passed
   - 0 failed

## Current Smart Portfolio architecture

Backend runtime flow:

1. `optimisation_tournee_api/next_best_visit_service.js`
   - production wrapper for Sales V2 / Smart Portfolio
   - request normalization
   - snapshot loading
   - prediction cache orchestration
   - delegates planning to the pure engine

2. `optimisation_tournee_api/next_best_visit_engine.js`
   - pure planning engine
   - sparse candidate-date generation orchestration
   - prediction resolution by candidate date
   - slot assignment
   - final portfolio decision synthesis
   - summary / diagnostics / block serialization

3. `optimisation_tournee_api/visit_opportunity_builder.js`
   - candidate date windows
   - predictive / hybrid / exploration opportunity construction
   - next-due window preservation
   - prediction field propagation into opportunities

4. `optimisation_tournee_api/visit_assignment_optimizer.js`
   - assignment constrained by selected commercials and slot capacity
   - same-day duplicate prevention
   - repeat-gap protection
   - soft balancing
   - route block construction

5. `optimisation_tournee_front/src/SalesCoveragePlanner.jsx`
   - Sales V2 page entry point
   - planning parameters
   - commercial multi-select
   - Smart Portfolio / feasibility / prediction summaries
   - generation flow

6. `optimisation_tournee_front/src/salesCoverageDetails.js`
   - frontend normalization layer
   - payload builders
   - summary builders
   - client row shaping
   - UI-safe formatting helpers

7. `optimisation_tournee_front/src/SalesTourClientTable.jsx`
   - per-visit business table
   - route order vs priority separation
   - honest quantity / value labels

8. `optimisation_tournee_front/src/SalesTourDetails.jsx`
   - block-level detail rendering
   - expected-value label alignment

9. `optimisation_tournee_api/next_best_visit_profile_snapshot_store.js`
   - persistent D3 snapshot metadata/state reader
   - source-data fingerprint computation
   - historical cutoff resolution
   - active snapshot staleness evaluation

10. `optimisation_tournee_api/next_best_visit_profile_readiness.js`
   - reusable automatic profile readiness coordinator
   - single-flight rebuild orchestration
   - retry-safe in-flight rebuild handling

11. `optimisation_tournee_api/next_best_visit_profile_snapshot_rebuilder.js`
   - persistent profile snapshot rebuild implementation
   - reused by readiness automation and CLI rebuild flows

12. `optimisation_tournee_api/server.js`
   - startup readiness trigger
   - readiness polling endpoint
   - readiness retry endpoint

## Bloc 3A architecture

Automatic profile readiness now reuses the existing D3 snapshot/profile infrastructure instead of introducing a second profile system.

Backend readiness flow:

1. `readProfileSnapshotState(...)` in `optimisation_tournee_api/next_best_visit_profile_snapshot_store.js`
   - computes the current source fingerprint
   - derives `latest_available_relevant_source_data_date`
   - derives the required historical cutoff date
   - derives the required profile version
   - classifies snapshot state as:
     - `ready`
     - `building`
     - `stale`
     - `failed`
     - `missing`

2. `ensureNextBestVisitProfilesReady(...)` in `optimisation_tournee_api/next_best_visit_profile_readiness.js`
   - returns immediately when profiles are `ready`
   - starts one background rebuild when profiles are `missing` or `stale`
   - reuses the same in-flight rebuild when concurrent calls arrive
   - returns `building` while the rebuild runs
   - exposes `failed` without leaving a permanent lock
   - allows retry via `forceRetry: true`

3. `runNextBestVisitProfileRebuildNow(...)`
   - central rebuild wrapper shared by:
     - the automatic readiness flow
     - the CLI rebuild script
   - rebuilds against the resolved required historical cutoff date

4. `optimisation_tournee_api/server.js`
   - triggers a non-blocking readiness check at backend startup
   - starts background rebuild when needed
   - never blocks the whole server startup for the rebuild duration
   - never crashes server startup if the rebuild fails

5. `GET /api/tournees/next-best-visits/readiness`
   - returns a stable readiness payload for the Sales V2 UI

6. `POST /api/tournees/next-best-visits/readiness/retry`
   - explicitly retries after a failed rebuild

7. `optimisation_tournee_front/src/SalesCoveragePlanner.jsx`
   - polls readiness automatically while profiles are building
   - disables `Generer` during build
   - reenables generation automatically when readiness becomes `ready`
   - shows a retry action only when readiness becomes `failed`

## Bloc 1 semantics still preserved

The validated Smart Portfolio semantics remain unchanged:

- business due status is computed before assignment constraints
- absence of compatible commercials never turns a due client into `not_due`
- `due_now + no compatible commercial` => `hard_constraint_unplanned`
- `overdue + no compatible commercial` => `hard_constraint_unplanned`
- `exploration_needed + no compatible commercial` => `hard_constraint_unplanned`
- truly `not_due + no compatible commercial` stays `not_due`
- missing compatible commercials never modify:
  - `next_due_date`
  - `next_due_window_start`
  - `next_due_window_end`
- exact client identity semantics remain preserved
  - leading zeros stay preserved
  - `00152` stays distinct from `152`
- `null` remains `null`
- weekends remain included in the planning horizon
- objective mode can change ranking and selected visits, but never removes active clients from portfolio tracking

## Bloc 2 files changed

Backend:

- `optimisation_tournee_api/next_best_visit_engine.js`
- `optimisation_tournee_api/next_best_visit_service.js`
- `optimisation_tournee_api/visit_opportunity_builder.js`
- `optimisation_tournee_api/tests/next_best_visit_service.test.cjs`
- `optimisation_tournee_api/tests/coverage_sales_coverage_integration.test.cjs`

Frontend:

- `optimisation_tournee_front/src/SalesCoveragePlanner.jsx`
- `optimisation_tournee_front/src/SalesCoveragePlanner.css`
- `optimisation_tournee_front/src/SalesTourClientTable.jsx`
- `optimisation_tournee_front/src/SalesTourDetails.jsx`
- `optimisation_tournee_front/src/salesCoverageDetails.js`
- `optimisation_tournee_front/src/__tests__/salesCoverageDetails.test.mjs`

Handoff:

- `HANDOFF_SALES_V2.md`

Note:
- the working tree already contained other unrelated or earlier in-progress changes; they were intentionally left untouched

## Bloc 3A files changed

Backend:

- `optimisation_tournee_api/next_best_visit_profile_snapshot_store.js`
- `optimisation_tournee_api/next_best_visit_profile_readiness.js`
- `optimisation_tournee_api/next_best_visit_service.js`
- `optimisation_tournee_api/server.js`
- `optimisation_tournee_api/scripts/rebuild_next_best_visit_profiles.cjs`
- `optimisation_tournee_api/tests/next_best_visit_profile_readiness.test.cjs`
- `optimisation_tournee_api/tests/next_best_visit_phase_d3.test.cjs`

Frontend:

- `optimisation_tournee_front/src/SalesCoveragePlanner.jsx`
- `optimisation_tournee_front/src/salesCoverageDetails.js`
- `optimisation_tournee_front/src/__tests__/salesCoverageReadiness.test.mjs`

Handoff:

- `HANDOFF_SALES_V2.md`

## Final UI behavior

Planning controls:

- the single-commercial selector is replaced by an accessible dropdown checklist
- the checklist supports:
  - `Tous les commerciaux`
  - one or many individual commercials
- closed label behavior:
  - all selected => `Tous les commerciaux`
  - one selected => that commercial label
  - several selected => `N commerciaux selectionnes`
- at least one commercial is required before generation

Capacity / parameter labels:

- `Charge cible / commercial / jour`
  - target operating load only
  - not a hard obligation to invent visits
- `Maximum / commercial / jour`
  - hard slot capacity

Summary hierarchy:

1. portfolio summary
   - total active clients
   - `due_now`
   - `due_soon`
   - `overdue`
   - `not_due`
   - `exploration_needed`
   - `capacity_unplanned`
   - `hard_constraint_unplanned`
   - `invalid_data`

2. executable plan summary
   - selected visits in horizon
   - selected commercials
   - horizon days
   - target capacity
   - maximum capacity
   - deficit / surplus / feasibility

3. prediction summary
   - prediction coverage
   - expected value / estimated CA only when available

Planned visit display:

- client
- portfolio status
- planned date
- commercial
- `Priorite IA`
- `VIP` only as a separate field
- route order shown separately as execution order
- concise date / reason explanation when available
- quantity and value labels are honest about model meaning

Map behavior:

- map remains an execution / routing visualization
- it does not imply geography is the business reason for the visit

## Multi-select API contract

Primary payload field:

- `commercial_codes: ["0001", "VL1900"]`

Compatibility behavior retained:

- `commercials` is still sent as the string array mirror where older code paths expect it
- `commercial_code` is still sent only when exactly one commercial is selected

Important contract rules:

- commercial codes are preserved as exact strings
- leading zeros must remain preserved
- selected commercials constrain assignment and capacity only
- selected commercials must not alter business due semantics
- capacity is recomputed from the count of selected commercials

## Quantity semantics found

Actual semantics in the current tree:

- `recommended_quantity` / `Qte_predite`
  - probability-weighted model estimate
  - not an executable rounded loading quantity

- `predicted_quantity_if_buy`
  - conditional quantity estimate if purchase happens

UI consequence:

- quantity is displayed as an estimate
- no packaging, rounding, or quantity-step rule is invented
- no executable loading quantity is claimed
- `null` stays `null`

## CA semantics found

Actual semantics in the current tree:

- `predicted_ca`
  - expected visit value
  - probability-weighted
  - should be labeled as `Valeur attendue de visite`

- `predicted_ca_if_buy`
  - conditional transaction value if purchase happens
  - should be labeled as `CA estime si achat`

UI consequence:

- unavailable CA is shown as unavailable, not `0`
- no unsupported mathematical reinterpretation is introduced

## Readiness states

Stable readiness states exposed by the backend and consumed by the UI:

- `ready`
- `building`
- `stale`
- `failed`
- `missing`

UI treatment:

- `ready`
  - `Generer` enabled
  - no readiness banner required

- `building`
  - `Generer` disabled
  - banner: `Preparation des profils clients en cours...`
  - automatic polling enabled

- `failed`
  - `Generer` disabled
  - useful error displayed
  - retry action shown

- `stale` / `missing`
  - backend auto-triggers rebuild where server dependencies are available
  - user-facing message remains preparation-oriented instead of exposing CLI instructions

## Staleness rule

The validated Bloc 3A staleness rule is:

- `required_cutoff = min(planning_start_date - 1 day, latest_available_relevant_source_data_date)`

with these consequences:

- changing `planning_start_date` alone does NOT make a valid snapshot stale when no newer relevant source data exists
- rebuild is required only for real causes such as:
  - missing snapshot
  - profile schema version change
  - algorithm/profile version change
  - newer relevant source data after the active snapshot
  - failed/corrupted snapshot state

This preserves D3 semantics and avoids needless rebuilds when the user chooses a different future planning date.

## Single-flight behavior

Single-flight rebuild behavior now implemented:

- first `missing` / `stale` request starts exactly one background rebuild
- simultaneous readiness calls reuse the same in-flight rebuild
- duplicate concurrent rebuilds are not started
- rebuild failure clears the in-flight lock
- a later retry can start a fresh rebuild

## Startup behavior

On backend startup:

- readiness is checked automatically
- when profiles are missing/stale, rebuild starts in the background
- startup does not wait for the rebuild to finish
- failures are logged clearly but do not crash the server

## UI behavior

Sales V2 now handles profile readiness automatically:

- the normal user never needs to run the CLI rebuild command
- `Generer` is disabled while readiness is `building`
- readiness is polled automatically until it becomes `ready`
- `Generer` becomes available without a manual page refresh
- failed readiness shows a useful error plus a retry action
- the page was not redesigned outside the minimal readiness UX needed for Bloc 3A

## Focused Bloc 3A tests executed and results

These focused tests were run and passed before the final single regression pass:

1. `node --test tests/next_best_visit_profile_readiness.test.cjs`
   - PASS
   - 7/7 tests passed
   - 0 failed

2. `node --test tests/next_best_visit_phase_d3.test.cjs`
   - PASS
   - 4/4 tests passed
   - 0 failed

3. `node --test src/__tests__/salesCoverageReadiness.test.mjs`
   - PASS
   - 4/4 tests passed
   - 0 failed

Full regression pass status:

- completed exactly once after the checkpoint handoff update
- all requested suites passed

Final regression summary:

- frontend regression: 33/33 passed
- backend/service/Smart Portfolio/D2-D5 regression: 60/60 passed
- Validation Lab full runner: 25/25 scenarios passed
- remaining failures: 0

## Exact tests executed and results

Frontend:

1. `node --test src/__tests__/salesCoverageDetails.test.mjs src/__tests__/validationLabConfig.test.mjs src/__tests__/salesCoverageReadiness.test.mjs`
   - PASS
   - 33/33 tests passed
   - 0 failed

Backend / Smart Portfolio / service serialization:

2. `node --test tests/coverage_sales_coverage_integration.test.cjs tests/next_best_visit_service.test.cjs tests/next_best_visit_smart_portfolio_core.test.cjs tests/next_best_visit_phase_d2.test.cjs tests/next_best_visit_phase_d3.test.cjs tests/next_best_visit_phase_d4.test.cjs tests/next_best_visit_phase_d5.test.cjs tests/next_best_visit_profile_readiness.test.cjs tests/next_best_visit_validation_lab.test.cjs`
   - PASS
   - 60/60 tests passed
   - 0 failed

Validation Lab full runner:

3. `node tests/run_next_best_visit_validation_lab.cjs`
   - PASS
   - scenarios: 25/25 passed
   - failed: 0
   - critical failures: 0
   - deterministic: true
   - total runtime: `6173 ms`
   - technical_validation_status: `passed`
   - logical_validation_status: `passed`
   - commercial_validation_status: `not_validated`

## Explicit Bloc 2 verification

Verified by the Bloc 2 tests now present in the tree:

- exact client codes remain exact strings
  - including leading-zero distinction such as `00152` vs `152`

- exact commercial codes remain exact strings
  - including leading-zero commercial codes such as `0001`

- `null` remains `null`

- 100% portfolio tracking invariant remains intact
  - Bloc 1 core and Validation Lab suites stayed green

- selected commercials affect assignment and capacity only, not business due semantics
  - covered by Smart Portfolio core and multi-commercial tests

- route order and priority are distinct
  - covered in frontend row-model tests

- quantity and CA labels reflect actual model semantics
  - covered in frontend row-model and metric tests

- no assignment is made to an unselected commercial
  - covered in backend assignment test

- capacity recomputes from selected commercial count
  - covered in frontend execution-summary and backend slot-capacity tests

## Performance status

Measured by the Validation Lab benchmark runner in the current working tree:

- 100 clients / 7 days
  - `45 ms`
  - target `250 ms`
  - sparsity `2.1%`

- 1000 clients / 14 days
  - `579 ms`
  - target `2000 ms`
  - sparsity `1.6%`

- 5768 clients / 14 days
  - `1805 ms`
  - target `8000 ms`
  - sparsity `1.6%`

- 5768 clients / 30 days
  - `3075 ms`
  - target `15000 ms`
  - sparsity `1.2%`

Current performance status:

- benchmark suite passed
- no benchmark threshold exceeded

## Remaining known issues

- `commercial_validation_status` remains `not_validated` in Validation Lab because the lab is synthetic and not a production commercial sign-off.
- the backend integration suite still emits a noisy `Erreur SQL de connexion: Pool is closed.` log line while passing; the test result is green, but the log remains noisy.
- Node test execution in this Codex environment required elevated execution because the sandbox blocked child-process spawning; this is an environment limitation, not a product regression.
- the repository working tree still contains unrelated pre-existing modifications outside this Bloc 3A pass; they were not reset or rewritten.

## Bloc 3B final regression results

Single final regression pass executed after the Bloc 3B checkpoint handoff update:

Frontend:

1. `node --test src/__tests__/salesCoverageDetails.test.mjs src/__tests__/salesCoverageReadiness.test.mjs src/__tests__/validationLabConfig.test.mjs`
   - PASS
   - 37/37 tests passed
   - 0 failed

Backend / Smart Portfolio / service serialization / Bloc 3A / Bloc 3B:

2. `node --test tests/next_best_visit_basket_loading.test.cjs tests/next_best_visit_profile_readiness.test.cjs tests/coverage_sales_coverage_integration.test.cjs tests/next_best_visit_service.test.cjs tests/next_best_visit_smart_portfolio_core.test.cjs tests/next_best_visit_phase_d2.test.cjs tests/next_best_visit_phase_d3.test.cjs tests/next_best_visit_phase_d4.test.cjs tests/next_best_visit_phase_d5.test.cjs tests/next_best_visit_validation_lab.test.cjs`
   - PASS
   - 64/64 tests passed
   - 0 failed

Validation Lab full runner:

3. `node tests/run_next_best_visit_validation_lab.cjs`
   - PASS
   - scenarios: 25/25 passed
   - failed: 0
   - critical failures: 0
   - deterministic: true
   - total runtime: `6000 ms`
   - technical_validation_status: `passed`
   - logical_validation_status: `passed`
   - commercial_validation_status: `not_validated`

## Bloc 3B explicit verification

Verified by the focused and final regression suites:

- exact client codes remain exact strings
- exact commercial codes remain exact strings
- exact product codes remain exact strings
- `null` remains `null`
- 100% portfolio tracking invariant remains intact
- selected commercials still affect assignment/capacity only, not business due semantics
- route order and priority remain distinct
- quantity labels remain estimates, not executable loading/order quantities
- CA labels remain aligned with the actual model semantics from Bloc 2
- loading aggregation adds no arbitrary safety margin
- products are never invented when history/model support is insufficient

## Bloc 3B performance impact

Practical impact in the current working tree:

- focused basket/loading backend tests stayed fast
- final backend regression remained green at `64/64`
- Validation Lab benchmark suite remained within thresholds

Latest Validation Lab benchmarks after Bloc 3B:

- 100 clients / 7 days
  - `51 ms`
  - target `250 ms`
  - sparsity `2.1%`

- 1000 clients / 14 days
  - `709 ms`
  - target `2000 ms`
  - sparsity `1.6%`

- 5768 clients / 14 days
  - `2259 ms`
  - target `8000 ms`
  - sparsity `1.6%`

- 5768 clients / 30 days
  - `2195 ms`
  - target `15000 ms`
  - sparsity `1.2%`

Current performance status:

- warm path remains interactive in the current environment
- D3 snapshot/profile cache and plan cache behavior remained preserved
- no benchmark threshold exceeded in the final regression pass

## Bloc 3B known limitations

- the current Sales V2 batch prediction path still does not natively expose a guaranteed product-level ML basket on every request; Bloc 3B therefore preserves model baskets when present and otherwise falls back to deterministic client history.
- `product_id` is left `null` in the historical fallback path because the validated inspected path reliably exposed `produit_code` / `libelle`, not a distinct product identifier contract for Sales V2.
- mixed-source loading rows can occur if some planned clients carry model baskets and others use historical fallback for the same product; the UI keeps the estimate honest, but there is not yet a separate optimization layer beyond estimation.
- the backend integration suite still emits the noisy `Erreur SQL de connexion: Pool is closed.` log line while remaining green.
- Node test execution in this Codex environment required elevated execution because the sandbox blocked child-process spawning; this is an environment limitation, not a product regression.
- unrelated pre-existing working-tree changes outside Bloc 3B were left untouched.

## Next step

Next step = CODE FREEZE / REPORT / PRESENTATION.

## Post-freeze frontend bug fix - readiness synchronization

Scope:

- fixed only the Sales V2 frontend readiness synchronization bug in `SalesCoveragePlanner`
- backend readiness/rebuild logic was not modified
- Smart Portfolio, Bloc 3A readiness semantics, and Bloc 3B basket/loading behavior were not modified

Files changed:

- `optimisation_tournee_front/src/SalesCoveragePlanner.jsx`
- `optimisation_tournee_front/src/salesCoverageDetails.js`
- `optimisation_tournee_front/src/__tests__/salesCoverageReadiness.test.mjs`

Bug summary:

- the readiness endpoint could already be returning `status=ready` while the frontend still remained visually stuck in the preparation state
- the planner mixed raw `readinessState.loading` with the derived readiness status, so background polling could keep Generate blocked and keep the verification/preparation UI path active
- overlapping readiness requests could also race, allowing an older response to overwrite a newer readiness payload

Frontend fix:

- normalized readiness into a single derived view-model in `buildSalesProfileReadinessViewModel`
- `ready` now wins when either the top-level readiness status or `profile_snapshot.status` is `ready`
- Generate blocking now follows the normalized readiness view-model instead of a separate raw `loading` blocker
- background refresh no longer disables Generate when the last committed readiness payload is already `ready`
- polling now stops from the normalized view-model state instead of mixed raw/derived flags
- `SalesCoveragePlanner` now ignores stale readiness responses using a monotonic in-flight request sequence guard
- the readiness label in the UI now uses the normalized view-model as its source of truth

Expected behavior after fix:

- when readiness is `building`, the page keeps polling automatically
- as soon as the endpoint returns `ready`, the polling loop stops
- the preparation banner disappears
- `Preparation des profils requise` is removed
- Generate becomes enabled automatically as long as the commercial selection is valid
- no manual refresh, curl call, or CLI rebuild step is required

Focused tests executed before the broader regression:

1. `node --test src/__tests__/salesCoverageReadiness.test.mjs`
   - PASS
   - 6/6 tests passed
   - 0 failed

Added regression coverage:

- building state enables polling and blocks Generate
- ready state enables Generate
- building -> polling -> ready transition re-enables Generate automatically
- a ready payload being refreshed does not re-block Generate
- planner source still polls readiness and exposes retry support

Known limitations after this fix:

- Node test execution in this Codex environment still required elevated execution because the sandbox blocked child-process spawning
- unrelated pre-existing working-tree changes outside this small frontend bug fix remain untouched

Next step remains = CODE FREEZE / REPORT / PRESENTATION.

## Bloc 4A architecture - terrain feedback / resultat reel

Bloc 4A closes the first execution loop for Sales V2:

- PLAN
- VISIT
- ACTUAL RESULT

This bloc stores terrain feedback only.

Explicitly not done:

- no retraining
- no cadence rewrite
- no priority rewrite
- no Smart Portfolio behavior change
- no future-planning mutation from feedback

Architecture added:

1. additive backend feedback service
   - `optimisation_tournee_api/sales_visit_feedback_service.js`
   - owns:
     - deterministic `planned_visit_id`
     - immutable prediction snapshot normalization
     - feedback read
     - idempotent feedback upsert

2. Sales V2 payload enrichment
   - `optimisation_tournee_api/next_best_visit_service.js`
   - each planned client now carries:
     - `planned_visit_id`
     - `assigned_slot_id`
     - `prediction_snapshot`

3. terrain feedback UI
   - `optimisation_tournee_front/src/SalesVisitFeedbackPanel.jsx`
   - mounted inside `SalesTourDetails`
   - one compact expandable form per planned client in the selected block

## Bloc 4A database / table changes

New additive table:

- `sales_v2_visit_feedback`

Stored fields:

- `planned_visit_id`
- `assigned_slot_id`
- `client_id`
- `client_code`
- `commercial_code`
- `planned_date`
- `execution_status`
- `purchase_made`
- `actual_ca`
- `actual_quantity`
- `visit_date_actual`
- `note`
- `non_visit_reason`
- `no_purchase_reason`
- `prediction_snapshot_json`
- timestamps

Design notes:

- this does not modify `entetecommercials`
- this does not modify `lignecommercials`
- this does not reuse `client_visits` as the Sales V2 execution-result store
- `client_visits` remains part of historical visit/profile intelligence

## Bloc 4A API contract

Read feedback:

- `GET /api/tournees/next-best-visits/visit-feedback`
- query:
  - `planned_visit_ids`
  - also accepts single `planned_visit_id`
- response:
  - `status`
  - `records`
  - `records_by_planned_visit_id`

Upsert feedback:

- `PUT /api/tournees/next-best-visits/visit-feedback/:plannedVisitId`
- idempotent for one planned visit
- validates:
  - allowed execution status
  - client/commercial/planned-date identity
  - numeric fields
  - nullable semantics

## Bloc 4A execution status semantics

- `pending`
  - planned visit exists, no actual terrain result saved yet

- `not_visited`
  - the planned visit was not executed
  - distinct from a visited client with no purchase

- `visited` + `purchase_made = false`
  - visit happened
  - no purchase was made

- `visited` + `purchase_made = true`
  - visit happened
  - purchase was made

Null semantics preserved:

- `actual_ca = null` stays `null`
- `actual_quantity = null` stays `null`
- unavailable actual values are never rewritten to `0`

## Bloc 4A prediction snapshot strategy

Each planned visit now carries a compact immutable planning snapshot:

- `predicted_ca`
- `predicted_ca_if_buy`
- `recommended_quantity`
- `predicted_quantity_if_buy`
- `priority`
- `portfolio_status`
- `planned_date`
- `basket_prediction_source`
- compact `recommended_products`

Behavior:

- the snapshot is stored on first feedback write
- later feedback updates do not overwrite that snapshot
- this preserves the original planning-time prediction for Bloc 4B predicted-vs-actual monitoring

## Bloc 4A UI behavior

In the selected Sales V2 block detail, a new section appears:

- `Resultat de la visite`

Per planned client:

- `Statut`
  - `En attente`
  - `Visite effectuee`
  - `Non visite`
- if visited:
  - `Achat realise`
  - `CA reel`
  - `Quantite reelle`
- optional:
  - `Note`
  - `Motif de non visite`
  - `Motif sans achat`

Behavior:

- save is explicit via `Enregistrer`
- saved feedback reloads back into the same UI state
- the main planning table stays compact

## Bloc 4A files changed

Backend:

- `optimisation_tournee_api/sales_visit_feedback_service.js`
- `optimisation_tournee_api/next_best_visit_service.js`
- `optimisation_tournee_api/server.js`
- `optimisation_tournee_api/tests/sales_visit_feedback_service.test.cjs`

Frontend:

- `optimisation_tournee_front/src/SalesVisitFeedbackPanel.jsx`
- `optimisation_tournee_front/src/SalesTourDetails.jsx`
- `optimisation_tournee_front/src/salesCoverageDetails.js`
- `optimisation_tournee_front/src/SalesCoveragePlanner.css`
- `optimisation_tournee_front/src/__tests__/salesCoverageDetails.test.mjs`

## Bloc 4A focused tests executed and results

Backend:

1. `node --test tests/sales_visit_feedback_service.test.cjs`
   - PASS
   - 5/5 tests passed
   - 0 failed

Frontend:

2. `node --test src/__tests__/salesCoverageDetails.test.mjs`
   - PASS
   - 33/33 tests passed
   - 0 failed

Focused coverage added:

- pending -> visited
- pending -> not_visited
- visited + purchase
- visited + no purchase
- `actual_ca = null` stays `null`
- `actual_quantity = null` stays `null`
- exact client code preserved
- exact commercial code preserved
- one feedback state per planned visit
- immutable prediction snapshot after update
- frontend payload honesty
- frontend reload of stored feedback state

Final relevant Sales V2 regression pass:

3. `node --test tests/sales_visit_feedback_service.test.cjs tests/next_best_visit_service.test.cjs tests/next_best_visit_profile_readiness.test.cjs tests/next_best_visit_basket_loading.test.cjs tests/coverage_sales_coverage_integration.test.cjs`
   - PASS
   - 36/36 tests passed
   - 0 failed

Regression coverage confirmed:

- Bloc 4A feedback storage and idempotent update
- Smart Portfolio service payload stability after planned-visit metadata enrichment
- Bloc 3A readiness/rebuild behavior unchanged
- Bloc 3B basket/loading behavior unchanged
- Sales V2 integration behavior unchanged

## Bloc 4A known limitations

- Bloc 4A stores execution result only; it does not create a full order-line entry workflow
- actual product lines are not captured here unless they already exist in real source order data elsewhere
- `visit_date_actual` is supported by the backend contract but not surfaced in the minimal UI yet
- Node test execution in this Codex environment still required elevated execution because the sandbox blocked child-process spawning

## Next step

Next step = Bloc 4B - Predicted vs Actual monitoring.

## Bloc 4B1 monitoring architecture

Bloc 4B1 adds the first read-only Predicted vs Actual monitoring layer on top of the immutable Bloc 4A feedback snapshot.

It does not:

- retrain any model
- change Smart Portfolio planning
- rewrite cadence
- invalidate prediction caches
- modify future planning decisions

Architecture added:

1. monitoring detail normalizer
   - `optimisation_tournee_api/sales_visit_feedback_service.js`
   - converts one feedback record + immutable prediction snapshot into a row-level comparison object

2. read-only monitoring aggregation
   - same service file
   - computes:
     - execution metrics
     - purchase outcome metrics
     - expected visit CA error metrics
     - conditional CA-if-buy error metrics
     - conditional quantity error metrics
   - supports bounded segmentation by:
     - commercial
     - planning date
     - portfolio status
     - prediction source when available from the stored snapshot

3. monitoring API
   - `optimisation_tournee_api/server.js`
   - read-only endpoints:
     - `GET /api/tournees/next-best-visits/feedback/monitoring`
     - `GET /api/tournees/next-best-visits/feedback/monitoring/details`

## Bloc 4B1 metric definitions

Execution metrics:

- `planned`
- `visited`
- `not_visited`
- `pending`
- `execution_rate = visited / planned`

Purchase metrics:

- evaluated only on executed visits where `purchase_made` is known
- `comparable_visits`
- `purchases`
- `no_purchase`
- `conversion_rate = purchases / comparable_visits`

Expected visit value comparison:

- uses `predicted_ca` from the stored planning snapshot
- for `visited + purchase_made = true + actual_ca known`
  - compares predicted expected visit CA vs actual CA
- for `visited + purchase_made = false`
  - realized visit CA is treated as `0` for expected-value comparison only
- excludes:
  - `pending`
  - `not_visited`
  - `visited + purchase_made = true + actual_ca = null`

Conditional CA-if-buy comparison:

- uses `predicted_ca_if_buy`
- compares only when:
  - visit executed
  - purchase happened
  - `actual_ca` is known

Quantity comparison:

- uses `predicted_quantity_if_buy`
- `recommended_quantity` remains exposed in row-level predicted data but is not used for the regression error metric
- compares only when:
  - visit executed
  - purchase happened
  - `actual_quantity` is known

Error metrics:

- `absolute_error`
- `signed_error = predicted - actual`
- aggregate:
  - `mae`
  - `bias`
  - `mape_valid_count`
  - `mape`

MAPE rule:

- only computed when `actual > 0`
- never computed on zero actual values

## Bloc 4B1 inclusion / exclusion rules

Included in execution metrics:

- every stored feedback row in the filtered date/commercial scope

Included in purchase metrics:

- executed visits with non-null `purchase_made`

Included in expected visit CA error:

- executed visits with known realized visit value semantics
- `visited + no_purchase` is included with realized visit CA = `0`

Excluded from prediction error metrics:

- `pending`
- `not_visited`
- executed purchase rows with unknown `actual_ca`
- quantity rows with unknown `actual_quantity`
- rows where the corresponding prediction field is unavailable

Null semantics preserved:

- unavailable predicted fields remain `null`
- unavailable actual fields remain `null`
- unavailable error fields remain `null`

## Bloc 4B1 API contract

Summary endpoint:

- `GET /api/tournees/next-best-visits/feedback/monitoring`
- optional filters:
  - `start_date`
  - `end_date`
  - `commercial_codes`
- response:
  - `status`
  - `filters`
  - `summary`
    - `execution`
    - `purchase`
    - `ca_expected`
    - `ca_if_buy`
    - `quantity`
  - `segmented`
    - `by_commercial`
    - `by_planning_date`
    - `by_portfolio_status`
    - `by_prediction_source`
  - `row_count`

Details endpoint:

- `GET /api/tournees/next-best-visits/feedback/monitoring/details`
- optional filters:
  - `start_date`
  - `end_date`
  - `commercial_codes`
- response:
  - `status`
  - `filters`
  - `rows`
  - `row_count`

Row shape:

- `planned_visit_id`
- `client_id`
- `client_code`
- `commercial_code`
- `planned_date`
- `execution_status`
- `purchase_made`
- `predicted`
  - `expected_visit_ca`
  - `ca_if_buy`
  - `estimated_quantity`
  - `quantity_if_buy`
  - `priority`
  - `portfolio_status`
  - `prediction_source`
- `actual`
  - `actual_ca`
  - `actual_quantity`
- `comparison`
  - `expected_ca_error`
  - `conditional_ca_error`
  - `quantity_error`

## Bloc 4B1 files changed

Backend:

- `optimisation_tournee_api/sales_visit_feedback_service.js`
- `optimisation_tournee_api/server.js`
- `optimisation_tournee_api/tests/sales_visit_feedback_monitoring.test.cjs`

## Bloc 4B1 focused tests executed and results

1. `node --test tests/sales_visit_feedback_monitoring.test.cjs`
   - PASS
   - 6/6 tests passed
   - 0 failed

Focused coverage added:

- visited + purchase + actual CA
- visited + no purchase => realized visit CA = 0 for expected-value comparison
- visited + purchase + `actual_ca = null` => excluded from CA error
- `not_visited` excluded from prediction error metrics
- `pending` excluded from prediction error metrics
- `predicted_ca_if_buy` compared only when purchase occurred
- quantity comparison only with valid `actual_quantity`
- null stays null
- MAPE excludes `actual = 0`
- exact client/commercial codes preserved
- aggregation overall
- aggregation by commercial
- aggregation by date
- bias sign check
- monitoring path remains read-only

Final relevant backend regression pass:

2. `node --test tests/sales_visit_feedback_monitoring.test.cjs tests/sales_visit_feedback_service.test.cjs tests/next_best_visit_service.test.cjs tests/next_best_visit_profile_readiness.test.cjs tests/next_best_visit_basket_loading.test.cjs tests/coverage_sales_coverage_integration.test.cjs`
   - PASS
   - 42/42 tests passed
   - 0 failed

Regression coverage confirmed:

- Bloc 4B1 monitoring metrics and filters
- Bloc 4A feedback storage and immutable snapshot preservation
- Sales V2 main service payload stability
- Bloc 3A readiness/rebuild behavior unchanged
- Bloc 3B basket/loading behavior unchanged
- Sales V2 backend integration behavior unchanged

## Bloc 4B1 known limitations

- Bloc 4B1 monitors only visits that already have a Bloc 4A feedback row; it does not infer execution from external order history
- purchase-probability calibration monitoring is not exposed because a purchase-probability field is not stored in the immutable Bloc 4A snapshot
- `recommended_quantity` is preserved in row-level predicted data for interpretation, but quantity error metrics use only `predicted_quantity_if_buy`

## Bloc 4B2 UI structure

Bloc 4B2 exposes the existing Bloc 4B1 monitoring results directly inside the Sales V2 frontend without changing backend monitoring semantics.

The monitoring entry point is a dedicated read-only section:

- `Suivi Prevu vs Reel`

Current structure in `optimisation_tournee_front/src/SalesCoveragePlanner.jsx`:

1. existing Sales V2 planning form
2. existing readiness / generation state banners
3. new monitoring section
4. existing executable plan result view

The UI stays additive and does not redesign the main page.

## Bloc 4B2 filters

The monitoring section exposes:

- `Date debut`
- `Date fin`
- `Commerciaux`

Commercial selection reuses the validated Bloc 2 multi-select checklist component:

- `optimisation_tournee_front/src/SalesCommercialMultiSelect.jsx`

Filter payloads are built only from the existing monitoring API contract through:

- `buildSalesMonitoringRequestPayload(...)`

Rules preserved:

- exact commercial codes remain exact strings
- empty selection remains an empty array until explicit selection
- no planning payload semantics were modified

## Bloc 4B2 KPIs

The monitoring section displays concise KPI cards for:

Execution:

- `Visites planifiees`
- `Visites effectuees`
- `Non visitees`
- `En attente`
- `Taux d execution`

Purchase:

- `Achats`
- `Sans achat`
- `Taux de conversion`

CA / quantity error:

- `MAE valeur attendue`
- `Biais CA`
- `MAE CA si achat`
- `MAE quantite`
- `Biais quantite`

Null semantics:

- unavailable metrics render as `Non disponible`
- valid zero values remain visible as real zeros
- no artificial "accuracy %" is introduced

Bias interpretation shown in UI:

- `Biais positif = surestimation. Biais negatif = sous-estimation.`

## Bloc 4B2 table fields

Visit-level monitoring table:

- `Client`
- `Commercial`
- `Date planifiee`
- `Statut visite`
- `Achat`
- `CA prevu visite`
- `CA reel`
- `Ecart visite`
- `CA prevu si achat`
- `Qte prevue si achat`
- `Qte reelle`
- `Ecart qte`

Segmented summaries:

- `Par commercial`
- `Par date`

Rendering rules:

- `null` values display `Non disponible`
- row formatting reuses the validated Bloc 4B1 semantics
- no charting layer was added
- the screen remains read-only and does not mutate feedback, planning, or predictions

## Bloc 4B2 files changed

Frontend:

- `optimisation_tournee_front/src/SalesCoveragePlanner.jsx`
- `optimisation_tournee_front/src/SalesFeedbackMonitoringPanel.jsx`
- `optimisation_tournee_front/src/SalesCommercialMultiSelect.jsx`
- `optimisation_tournee_front/src/salesCoverageDetails.js`
- `optimisation_tournee_front/src/SalesCoveragePlanner.css`
- `optimisation_tournee_front/src/__tests__/salesFeedbackMonitoring.test.mjs`

Handoff:

- `HANDOFF_SALES_V2.md`

## Bloc 4B2 focused tests executed and results

Focused frontend pass after implementation stabilization:

1. `node --test src/__tests__/salesFeedbackMonitoring.test.mjs src/__tests__/salesCoverageDetails.test.mjs src/__tests__/salesCoverageReadiness.test.mjs`
   - PASS
   - 47/47 tests passed
   - 0 failed

Focused coverage confirmed:

- API data normalization
- exact commercial code preservation
- null => `Non disponible`
- valid zero remains visible
- KPI formatting and rendering semantics
- predicted vs actual row formatting
- positive and negative bias display
- loading / error / empty monitoring states
- monitoring section remains wired to the two existing Bloc 4B1 APIs only

## Bloc 4B2 known limitations

- monitoring UI currently renders segmented summaries as tables only; no chart layer was added
- the row-level table uses client code first and falls back to client id only when code is unavailable
- monitoring remains bounded to data returned by Bloc 4B1; it does not infer missing actuals or fabricate comparable metrics
- Node test execution in this Codex environment still required elevated execution because the sandbox blocked child-process spawning

## Bloc 4C1 monitoring and candidate-learning architecture

Bloc 4C1 adds a controlled candidate-retraining layer on top of the already validated Sales V2 stack.

It reuses:

- Bloc 4A execution feedback from `sales_v2_visit_feedback`
- Bloc 4B1 feedback filtering and monitoring semantics
- the existing Python XGBoost artifacts loaded by `optimisation_tournee_api/api_ia.py`
- the existing engineered historical dataset `dataset_features_clients_jour.csv`

It does NOT:

- overwrite the production model artifacts
- retrain automatically on every feedback row
- modify Smart Portfolio planning semantics
- change readiness / rebuild behavior

Current flow:

1. Node service loads validated feedback rows through `fetchSalesVisitFeedbackMonitoringRecords(...)`
2. Node service filters only training-eligible execution rows
3. Node service applies a deterministic temporal split on feedback rows
4. Node service calls the Python candidate runner with:
   - current model metadata
   - train feedback rows
   - holdout feedback rows
   - configurable thresholds
5. Python runner rebuilds only candidate targets and evaluates:
   - current model
   - candidate model
   on the same holdout
6. Candidate metadata is persisted in `sales_v2_learning_candidates`
7. Production artifacts remain untouched

## Bloc 4C1 feedback dataset semantics

Feedback rows are normalized from Bloc 4A storage and reused exactly as stored.

Included for purchase learning:

- `execution_status = visited`
- `purchase_made = true|false`

Excluded from purchase/demand learning:

- `pending`
- `not_visited`
- rows with unknown `purchase_made`

Included for CA conditional-on-purchase learning:

- `visited`
- `purchase_made = true`
- `actual_ca` known

Excluded from CA target:

- `purchase_made = false`
- `actual_ca = null`
- `pending`
- `not_visited`

Included for quantity conditional-on-purchase learning:

- `visited`
- `purchase_made = true`
- `actual_quantity` known

Excluded from quantity target:

- `actual_quantity = null`
- `purchase_made = false`
- `pending`
- `not_visited`

Null semantics are preserved:

- unknown actual values are excluded, not converted to `0`
- exact client codes remain exact strings
- exact commercial codes remain exact strings

## Bloc 4C1 targets retrained

Bloc 4C1 retrains only targets that already exist in the current pipeline and are semantically supported by real feedback:

- `purchase_probability`
- `ca_if_buy`
- `quantity_if_buy`

Bloc 4C1 does not retrain:

- `predicted_ca` directly
  - it remains a derived expected visit value
- unit price model
- assignment model
- Smart Portfolio business semantics

## Bloc 4C1 exclusions and leakage prevention

Feedback outcomes are never used as input features for the same observation.

Feature construction for feedback rows reuses the historical as-of-date candidate state from `api_ia.select_prediction_candidates(...)`, then applies the existing `api_ia.build_features(...)` transformation.

Only labels come from feedback:

- purchase result
- actual CA
- actual quantity

This keeps outcome values out of the feature vector.

## Bloc 4C1 temporal split

Temporal ordering is enforced in two layers:

1. Node side:
   - feedback rows are sorted by:
     - `planned_date`
     - `planned_visit_id`
   - holdout rows are always the latest feedback rows

2. Python side:
   - historical training rows are truncated at `training_data_cutoff`
   - holdout evaluation uses only the later feedback holdout rows

This prevents future feedback from leaking into earlier training rows.

## Bloc 4C1 model versioning

Current model metadata is derived from existing artifact hashes:

- `model_version`
- `feature_schema_version`
- `trained_at`

Candidate metadata is additive and persisted separately in:

- `sales_v2_learning_candidates`

Stored fields include:

- `candidate_version`
- `status`
  - `candidate`
  - `rejected`
  - `failed`
  - existing candidates are archived when a newer accepted candidate is stored
- `base_current_model_version`
- `feature_schema_version`
- `trained_at`
- `training_data_cutoff`
- holdout window
- feedback row counts
- retrained targets
- metrics/comparison JSON
- artifact manifest
- error message

The candidate version is deterministic for identical inputs and distinct from the current production model version.

Production artifacts are never overwritten by Bloc 4C1.

## Bloc 4C1 candidate training flow

Backend service:

- `optimisation_tournee_api/sales_learning_candidate_service.js`

Python runner:

- `optimisation_tournee_api/train_candidate_feedback.py`

Current candidate-training behavior:

- uses the same XGBoost hyperparameters as `train_auto.py`
- reuses production feature columns and artifact loaders from `api_ia.py`
- trains candidate artifacts in a dedicated directory:
  - `optimisation_tournee_api/candidate_models/<candidate_version>/...`
- persists metadata only after training/evaluation
- persists a failed candidate record when the runner crashes

## Bloc 4C1 current-vs-candidate metrics

Purchase target metrics:

- `auc` when both classes are present on holdout
- `logloss`
- `bias`
- comparable / positive / negative counts

Regression targets (`ca_if_buy`, `quantity_if_buy`) expose:

- `mae`
- `rmse`
- `bias`
- `mape` only where actual > 0
- comparable count

Current and candidate are evaluated on the same holdout rows.

Returned recommendation values:

- `candidate_better`
- `current_better`
- `insufficient_data`

The recommendation is intentionally conservative:

- if no comparable metric exists -> `insufficient_data`
- candidate must avoid regressions on the compared metrics to be considered better

## Bloc 4C1 configurable minimum feedback requirement

Configurable minimum new valid feedback:

- env: `SALES_V2_LEARNING_MIN_VALID_FEEDBACK_ROWS`
- current default: `30`

Additional split controls:

- `SALES_V2_LEARNING_HOLDOUT_RATIO`
- `SALES_V2_LEARNING_MIN_HOLDOUT_ROWS`

If valid feedback is below the minimum:

- no candidate training starts
- status returned = `insufficient_data`
- production model remains untouched

## Bloc 4C1 API contract

Read-only status:

- `GET /api/tournees/next-best-visits/learning/status`

Optional filters:

- `start_date`
- `end_date`
- `commercial_codes`

Candidate retrain:

- `POST /api/tournees/next-best-visits/learning/retrain-candidate`

Body filters supported:

- `start_date`
- `end_date`
- `commercial_codes`

Returned data includes:

- current model metadata
- latest candidate metadata
- feedback availability counts
- candidate comparison payload when training runs

## Bloc 4C1 database / table changes

New additive table:

- `sales_v2_learning_candidates`

No historical source commercial/order table is mutated by Bloc 4C1.

## Bloc 4C1 files changed

Backend:

- `optimisation_tournee_api/sales_learning_candidate_service.js`
- `optimisation_tournee_api/train_candidate_feedback.py`
- `optimisation_tournee_api/server.js`
- `optimisation_tournee_api/next_best_visit_versions.js`
- `optimisation_tournee_api/tests/sales_learning_candidate_service.test.cjs`

Handoff:

- `HANDOFF_SALES_V2.md`

## Bloc 4C1 focused tests executed and results

Focused backend pass after implementation stabilization:

1. `node --test tests/sales_learning_candidate_service.test.cjs`
   - PASS
   - 5/5 tests passed
   - 0 failed

Focused coverage confirmed:

- pending feedback excluded
- `not_visited` excluded from demand learning
- visited purchase rows with valid actual values included
- exact client and commercial codes preserved
- deterministic candidate versioning
- temporal split respected
- candidate output directory isolated from production artifacts
- failed training persists failed candidate metadata without changing current model metadata
- non-success candidate result remains visible in status

## Bloc 4C1 known limitations

- Bloc 4C1 prepares and evaluates a candidate only; it does not promote automatically
- the candidate runner currently retrains only:
  - purchase probability
  - CA if buy
  - quantity if buy
- unit price and commercial assignment are intentionally left unchanged in this bloc
- no frontend UI for candidate learning exists yet in Bloc 4C1
- Node test execution in this Codex environment still required elevated execution because the sandbox blocked child-process spawning

## Bloc 4C2A promotion policy

Bloc 4C2A introduces a safe candidate promotion / rollback layer on top of the Bloc 4C1 learning metadata.

Promotion stays disabled by default unless a trained candidate is explicitly promoted through the API.

Promotion gates are configurable and currently use these defaults:

- `SALES_V2_LEARNING_PROMOTION_MIN_EVAL_OBSERVATIONS`
  - default: `10`
- `SALES_V2_LEARNING_PROMOTION_REGRESSION_ALLOWED_MAE_DEGRADATION`
  - default: `0`
- `SALES_V2_LEARNING_PROMOTION_REGRESSION_ALLOWED_RMSE_DEGRADATION`
  - default: `0`
- `SALES_V2_LEARNING_PROMOTION_CLASSIFICATION_ALLOWED_LOGLOSS_DEGRADATION`
  - default: `0`
- `SALES_V2_LEARNING_PROMOTION_CLASSIFICATION_ALLOWED_AUC_DEGRADATION`
  - default: `0`
- `SALES_V2_LEARNING_PROMOTION_MIN_PRIMARY_IMPROVEMENT`
  - default: `0`

Primary metrics by target:

- `purchase_probability`
  - primary metric: `logloss`
  - secondary metric: `auc`
- `ca_if_buy`
  - primary metric: `mae`
  - secondary metric: `rmse`
- `quantity_if_buy`
  - primary metric: `mae`
  - secondary metric: `rmse`

## Bloc 4C2A comparison gates

A candidate is promotable only if all of the following are true:

- candidate status = `candidate`
- candidate comparison status = `success`
- candidate `base_current_model_version` matches the live production model version
- candidate `feature_schema_version` matches the live production feature schema version
- current and candidate metrics come from the same holdout counts
- each promoted target has enough comparable observations
- each promoted target is not worse than the configured tolerance
- each promoted target shows at least the configured minimum improvement
- candidate artifacts exist for every retrained/promoted target

Possible promotion outcomes:

- `successful`
- `current_retained`
- `insufficient_evidence`
- `failed`

## Bloc 4C2A atomic promotion flow

Promotion is implemented in:

- `optimisation_tournee_api/sales_learning_candidate_service.js`

Flow:

1. validate candidate metadata and policy eligibility
2. validate candidate artifact presence target-by-target
3. build a staged production bundle in a temp directory
4. archive the current production artifact bundle
5. copy the staged bundle into production artifact paths
6. request a safe Flask model reload
7. verify the running prediction service exposes the expected promoted model version and feature schema version
8. invalidate only model-dependent caches
9. mark candidate as promoted and persist promotion audit

If any step fails:

- previous production artifacts are restored from the archive
- the service attempts to reload the previous model again
- the promotion is audited as failed
- production remains usable

## Bloc 4C2A rollback flow

Rollback is explicit and safe.

Rollback behavior:

- target version can be provided explicitly
- otherwise the service falls back to the previous version recorded in the latest promotion audit
- current production is archived before rollback
- archived target artifacts are restored into production paths
- Flask model reload is requested
- running model version is verified
- only model-dependent caches are invalidated
- rollback audit is persisted

If rollback fails:

- the service restores the pre-rollback current bundle when possible
- production remains on the previous working version

## Bloc 4C2A model reload behavior

Node now reuses the existing Flask model lifecycle:

- `POST /api/reload-models`
- `GET /api/model-status`

Promotion and rollback never require the user to manually copy files or run CLI commands.

The production model is reloaded in-process through Flask only after artifact validation/copying succeeds.

Verification checks:

- `ready = true`
- expected `model_version`
- expected `features_version`

## Bloc 4C2A cache / version behavior

Model version identity now depends on artifact content, not only timestamps.

`buildArtifactVersionFromFiles(...)` now hashes:

- file presence
- file size
- file content SHA1

This avoids false "same version" results after file copies on Windows and ensures promoted/rolled-back bundles receive stable content-based versions.

Only model-dependent caches are invalidated after promotion/rollback:

- generic request-level IA prediction memory cache
- coverage purchase prediction in-memory cache
- coverage purchase prediction disk cache directory when enabled
- Sales V2 next-best-visit plan cache

Bloc 4C2A does NOT invalidate:

- Smart Portfolio cadence/profile snapshots
- unrelated historical source data

The persistent next-best-visit prediction cache already keys rows by:

- `model_version`
- `features_version`
- `source_data_version`

so old predictions are not silently reused as new-model predictions.

## Bloc 4C2A API contract

Promotion:

- `POST /api/tournees/next-best-visits/learning/promote-candidate`
  - optional body:
    - `candidate_version`

Rollback:

- `POST /api/tournees/next-best-visits/learning/rollback`
  - optional body:
    - `model_version`

Status:

- `GET /api/tournees/next-best-visits/learning/status`

The status payload now also exposes:

- latest promotion audit
- promotion policy

## Bloc 4C2A database / metadata changes

New additive audit table:

- `sales_v2_learning_promotions`

Stored fields include:

- `action_type`
- `status`
- `candidate_version`
- `previous_model_version`
- `resulting_model_version`
- `rollback_target_version`
- `feature_schema_version`
- `policy_json`
- `evaluation_json`
- `artifact_manifest_json`
- `decision_reason`
- `error_message`
- timestamps

## Bloc 4C2A files changed

Backend:

- `optimisation_tournee_api/sales_learning_candidate_service.js`
- `optimisation_tournee_api/server.js`
- `optimisation_tournee_api/api_ia.py`
- `optimisation_tournee_api/next_best_visit_service.js`
- `optimisation_tournee_api/next_best_visit_versions.js`
- `optimisation_tournee_api/tests/sales_learning_promotion_service.test.cjs`

Handoff:

- `HANDOFF_SALES_V2.md`

## Bloc 4C2A focused tests executed and results

Focused backend promotion / rollback pass after implementation stabilization:

1. `node --test optimisation_tournee_api/tests/sales_learning_promotion_service.test.cjs`
   - PASS
   - 5/5 tests passed
   - 0 failed

Covered cases:

- better candidate => promotable
- worse candidate => current retained
- insufficient evidence => no promotion
- incompatible schema => no promotion
- missing candidate artifact => no promotion
- failed reload => previous model restored
- successful promotion archives current artifacts
- rollback restores previous archived version
- exact model version metadata preserved in audit flow
- no Smart Portfolio business semantics touched

Relevant backend regression pass:

1. `node --test tests/sales_learning_promotion_service.test.cjs tests/sales_learning_candidate_service.test.cjs tests/sales_visit_feedback_monitoring.test.cjs tests/sales_visit_feedback_service.test.cjs tests/next_best_visit_service.test.cjs tests/next_best_visit_profile_readiness.test.cjs tests/next_best_visit_basket_loading.test.cjs tests/coverage_sales_coverage_integration.test.cjs`
   - PASS
   - 52/52 tests passed
   - 0 failed

## Bloc 4C2A known limitations

- Bloc 4C2A promotes or rolls back only the targets already trained in Bloc 4C1:
  - purchase probability
  - CA if buy
  - quantity if buy
- unit price and commercial assignment remain outside the promotion scope in this bloc
- candidate promotion still depends on the Flask prediction service being reachable for reload/status verification
- Node test execution in this Codex environment still requires elevated execution because the sandbox blocks child-process spawning

## Bloc 4C2B automatic learning cycle architecture

Bloc 4C2B completes the controlled learning loop on top of Bloc 4C1 candidate retraining and Bloc 4C2A promotion / rollback.

The automatic flow is now:

1. read stored Sales V2 visit feedback from `sales_v2_visit_feedback`
2. derive valid learning rows using the SAME purchase-learning semantics as Bloc 4C1
3. compare the current valid-feedback set against the last processed / last failed cycle state
4. if enough NEW valid feedback exists, launch one background candidate cycle
5. train candidate
6. evaluate current vs candidate on the same holdout
7. reuse Bloc 4C2A promotion eligibility
8. promote safely if eligible, otherwise keep current model
9. persist the final cycle state and feedback cutoff/signature

No duplicate training logic was created.

## Bloc 4C2B trigger rule

Automatic learning runs only when:

- the valid purchase-learning feedback count reaches the configured minimum threshold
- the feedback set is NEW compared with the last completed cycle
- no other learning cycle is already running

If the feedback set is unchanged since the last completed cycle:

- status becomes `waiting_for_feedback`
- no retraining starts

If the same feedback set already failed in the previous cycle:

- status remains `failed`
- automatic retraining does NOT loop forever on the same failing lot
- a later new feedback lot or an explicit retry may start a new cycle

## Bloc 4C2B feedback cutoff semantics

The cycle tracks the latest feedback marker across eligible rows using:

- `updated_at` first
- fallback `created_at`
- fallback planned date only if timestamps are missing

Stored cycle metadata includes:

- `feedback_cutoff_used`
- `processed_feedback_signature`
- `processed_feedback_rows`
- `failed_feedback_signature`
- `failed_feedback_rows`

This prevents endless retraining on the same already-consumed dataset while still allowing a new cycle when fresh feedback arrives.

## Bloc 4C2B cycle states

Persisted / exposed states:

- `idle`
- `waiting_for_feedback`
- `training`
- `evaluating`
- `promoting`
- `current_kept`
- `promoted`
- `failed`

These are stored in the additive table:

- `sales_v2_learning_cycle_state`

## Bloc 4C2B background interval / config

New configurable backend controls:

- `SALES_V2_LEARNING_AUTO_ENABLED`
  - default: enabled
- `SALES_V2_LEARNING_AUTO_CHECK_INTERVAL_MS`
  - default: `1800000` (30 minutes)
- `SALES_V2_LEARNING_AUTO_STARTUP_DELAY_MS`
  - default: `15000` (15 seconds)

Behavior:

- backend startup remains non-blocking
- after bootstrap, a delayed automatic learning check runs in background
- then a slow interval checks whether enough NEW valid feedback exists
- normal planning and prediction requests remain usable during training

## Bloc 4C2B single-flight behavior

Only ONE automatic cycle may run at a time.

Implementation:

- module-level single-flight promise in `sales_learning_candidate_service.js`
- concurrent checks reuse the same in-flight promise/result
- duplicate Python retraining processes are prevented

## Bloc 4C2B promotion / current-retained behavior

If the candidate is better and passes Bloc 4C2A gates:

- state becomes `promoted`
- current production model is updated through the existing safe promotion path

If the candidate is not better or evidence is insufficient:

- state becomes `current_kept`
- current production model remains unchanged
- the processed feedback signature/cutoff is STILL marked as consumed

This means a rejected candidate is treated as a valid completed cycle, not an application failure.

## Bloc 4C2B failure safety

If dataset build, retraining, evaluation, promotion, reload, or verification fails:

- current production model remains active
- state becomes `failed`
- failure reason is stored
- the system remains usable for prediction/planning
- automatic retraining does not loop forever on the same failed feedback lot
- future new feedback or explicit retry can launch a new cycle

## Bloc 4C2B API contract

Existing status endpoint extended:

- `GET /api/tournees/next-best-visits/learning/status`

Additional fields now exposed:

- `learning_cycle_status`
- `last_cycle_started_at`
- `last_cycle_finished_at`
- `new_valid_feedback_count`
- `minimum_feedback_required`
- `feedback_cutoff_used`
- `last_decision`
- `last_reason`
- `latest_comparison_summary`
- `learning_cycle`

Optional manual control endpoint added for admin/testing:

- `POST /api/tournees/next-best-visits/learning/run-cycle`
  - body:
    - `force` (optional boolean)

Normal users still do NOT need any CLI/manual model copy/restart flow.

## Bloc 4C2B minimal UI learning status

In the existing `Suivi Prevu vs Reel` area, a compact `Apprentissage du modele` section now shows:

- `Modele actuel`
- `Nouveau feedback disponible`
- `Etat apprentissage`
- `Derniere evaluation`
- `Derniere decision`

Frontend behavior:

- status is read-only
- it uses `GET /api/tournees/next-best-visits/learning/status`
- it polls automatically only while the cycle is active:
  - `training`
  - `evaluating`
  - `promoting`

No new dashboard or redesign was introduced.

## Bloc 4C2B files changed

Backend:

- `optimisation_tournee_api/sales_learning_candidate_service.js`
- `optimisation_tournee_api/server.js`
- `optimisation_tournee_api/tests/sales_learning_candidate_service.test.cjs`
- `optimisation_tournee_api/tests/sales_learning_promotion_service.test.cjs`
- `optimisation_tournee_api/tests/sales_learning_automatic_cycle.test.cjs`

Frontend:

- `optimisation_tournee_front/src/SalesCoveragePlanner.jsx`
- `optimisation_tournee_front/src/SalesFeedbackMonitoringPanel.jsx`
- `optimisation_tournee_front/src/salesCoverageDetails.js`
- `optimisation_tournee_front/src/__tests__/salesFeedbackMonitoring.test.mjs`

Handoff:

- `HANDOFF_SALES_V2.md`

## Bloc 4C2B focused tests executed and results

Focused backend learning-cycle pass:

1. `node --test optimisation_tournee_api/tests/sales_learning_automatic_cycle.test.cjs optimisation_tournee_api/tests/sales_learning_candidate_service.test.cjs optimisation_tournee_api/tests/sales_learning_promotion_service.test.cjs`
   - PASS
   - 16/16 tests passed
   - 0 failed

Covered automatic-cycle cases:

- insufficient new feedback => no retraining
- enough new feedback => one cycle starts
- same feedback does not retrigger endlessly
- concurrent checks => single-flight
- candidate worse => current retained
- failed training => current model untouched
- future cycle can retry after failure/new feedback
- status API accurately represents the cycle

Focused frontend status pass:

1. `node --test src/__tests__/salesFeedbackMonitoring.test.mjs`
   - PASS
   - 9/9 tests passed
   - 0 failed

Covered UI/status cases:

- API data normalization
- loading/error/empty monitoring state
- learning status normalization
- polling semantics for active cycle states
- presence of the learning status section and labels

## Bloc 4C2B known limitations

- Bloc 4C2B uses the existing purchase-learning eligibility from Bloc 4C1 as the automatic trigger basis
- automatic cycles still depend on the Flask prediction service being reachable for model reload/status checks during promotion
- the new `sales_v2_learning_cycle_state` table stores the latest cycle state only; it is not a full historical audit log
- promotion / rollback audit history remains in `sales_v2_learning_promotions`
- Node test execution in this Codex environment still required elevated execution because the sandbox blocked child-process spawning

## Next step

Next step = FINAL APPLICATION VALIDATION / CODE FREEZE.

## Final application validation

Final validation date:

- 2026-08-10

Validation scope:

- application startup
- automatic profile readiness without CLI
- Sales V2 multi-commercial plan generation
- Smart Portfolio / assignment / capacity / route-order verification
- prediction label and null-semantics verification
- basket and estimated loading verification
- visit feedback persistence
- `Suivi Prevu vs Reel` monitoring verification
- `Apprentissage du modele` learning-status verification
- automatic learning wait state with insufficient feedback
- controlled learning cycle with sufficient feedback
- candidate evaluation and safe current-retained behavior
- production-model usability after the cycle
- confirmation that feedback / learning do not alter Smart Portfolio business semantics

Live end-to-end validation results:

- application stack started normally
  - Node API
  - Flask IA service
  - frontend dev server
- profile readiness transitioned to `ready` automatically without any CLI rebuild
- Sales V2 plan generation worked with a real multi-commercial payload
- Smart Portfolio population invariant remained valid
- capacities, assignments, route ordering, basket prediction, and loading prediction were present and coherent
- visit feedback was saved and reloaded successfully for:
  - `visited + purchase`
  - `visited + no purchase`
  - `not_visited`
- monitoring endpoints updated correctly from saved feedback
- automatic learning initially stayed in `waiting_for_feedback` when insufficient valid feedback was available
- after enough valid feedback was inserted, a controlled learning cycle ran successfully
- the candidate evaluation concluded `current_retained`
- the current production model remained active and usable after the cycle
- no Smart Portfolio business semantics were changed by feedback or learning

## Final validation bug fixes

Two blocking bugs were discovered and fixed during the final validation pass.

1. Feedback `planned_date` / monitoring date normalization

Files changed:

- `optimisation_tournee_api/sales_visit_feedback_service.js`
- `optimisation_tournee_api/tests/sales_visit_feedback_service.test.cjs`

Root cause:

- MySQL `DATE` values were being returned as JavaScript `Date` objects
- `planned_date` was normalized as if it were plain text
- feedback reload could return `planned_date = null`
- monitoring aggregation could shift the planning date by one day

Fix:

- normalize `Date` values explicitly as date-only values
- preserve database day semantics during feedback reload and monitoring aggregation

Validation after fix:

- focused feedback-service suite passed
- live feedback reload preserved `planned_date`
- live monitoring aggregation used the correct planning date

2. Windows-safe candidate artifact directory for automatic learning

Files changed:

- `optimisation_tournee_api/sales_learning_candidate_service.js`
- `optimisation_tournee_api/tests/sales_learning_candidate_service.test.cjs`

Root cause:

- candidate artifact directories were created from raw version strings containing `:`
- this produced invalid Windows paths during candidate training

Fix:

- reuse the existing safe version-path encoding for candidate artifact directories

Validation after fix:

- focused learning-service / automatic-cycle suites passed
- a live forced learning cycle completed successfully
- result was `current_retained`, with the production model still usable

## Final validation focused tests executed and results

1. `node --test optimisation_tournee_api/tests/sales_visit_feedback_service.test.cjs`
   - PASS
   - 6/6 tests passed
   - 0 failed

2. `node --test optimisation_tournee_api/tests/sales_learning_candidate_service.test.cjs optimisation_tournee_api/tests/sales_learning_automatic_cycle.test.cjs`
   - PASS
   - 12/12 tests passed
   - 0 failed

## Final regression suite executed and results

Backend final regression pass:

1. `node --test optimisation_tournee_api/tests/sales_visit_feedback_service.test.cjs optimisation_tournee_api/tests/sales_visit_feedback_monitoring.test.cjs optimisation_tournee_api/tests/sales_learning_candidate_service.test.cjs optimisation_tournee_api/tests/sales_learning_automatic_cycle.test.cjs optimisation_tournee_api/tests/sales_learning_promotion_service.test.cjs optimisation_tournee_api/tests/next_best_visit_service.test.cjs optimisation_tournee_api/tests/next_best_visit_profile_readiness.test.cjs optimisation_tournee_api/tests/next_best_visit_basket_loading.test.cjs optimisation_tournee_api/tests/coverage_sales_coverage_integration.test.cjs`
   - PASS
   - 60/60 tests passed
   - 0 failed

Frontend final regression pass:

1. `node --test src/__tests__/coveragePlannerDetails.test.mjs src/__tests__/coveragePlannerUtils.test.mjs src/__tests__/salesCoverageDetails.test.mjs src/__tests__/salesCoverageReadiness.test.mjs src/__tests__/salesFeedbackMonitoring.test.mjs src/__tests__/tourRouteUtils.test.mjs src/__tests__/validationLabConfig.test.mjs`
   - PASS
   - 64/64 tests passed
   - 0 failed

## Final known limitations

- `learning/status` may still retain a stale `last_error_message` field even after a subsequent successful `current_kept` cycle result; the cycle state and production-model safety remain correct
- automatic learning still depends on the Flask prediction service being reachable for promotion/reload verification
- this Codex environment still required elevated Node execution because the sandbox blocks child-process spawning
- the backend regression suite may still emit the known non-blocking test log `Erreur SQL de connexion: Pool is closed.` while all assertions pass

## Final status

Final status = CODE FREEZE.

## FINAL UX CLEANUP

Date: 2026-08-11

Scope:

- presentation cleanup only
- no backend monitoring, learning, readiness, feedback, promotion, rollback, or Smart Portfolio semantics changed
- normal Sales V2 UI no longer exposes internal AI lifecycle details

Files changed:

- `optimisation_tournee_front/src/SalesCoveragePlanner.jsx`
- `optimisation_tournee_front/src/salesCoverageDetails.js`
- `optimisation_tournee_front/src/__tests__/salesCoverageReadiness.test.mjs`
- `optimisation_tournee_front/src/__tests__/salesFeedbackMonitoring.test.mjs`
- `optimisation_tournee_front/src/__tests__/salesCoverageDetails.test.mjs`

UI cleanup behavior:

- hidden from the normal Sales V2 workflow:
  - `Suivi Prevu vs Reel`
  - `Apprentissage du modele`
  - model versions
  - learning-cycle state/details
  - feedback counters
  - candidate/promotion information
  - technical readiness/profile/cache information
  - `Preparation des profils requise`
- readiness remains fully automatic internally
- when readiness is not yet ready, the planner now shows only:
  - `Preparation en cours...`
- Generate becomes enabled automatically as soon as readiness returns to `ready`
- the normal Sales V2 page remains focused on:
  - planning parameters
  - Generate
  - Smart Portfolio / executable plan results
  - clients / dates / commercials
  - `Priorite IA`
  - honest CA / quantity estimates
  - basket estimate
  - estimated loading
  - route / ordre / carte

Feedback entry semantics verified:

- real visit feedback still enters through the existing visit-detail feedback panel (`SalesVisitFeedbackPanel`)
- no automatic inference from missing orders was introduced
- no feedback semantics were changed in this cleanup

Focused frontend tests executed and results:

1. `node --test src/__tests__/salesCoverageReadiness.test.mjs src/__tests__/salesFeedbackMonitoring.test.mjs src/__tests__/salesCoverageDetails.test.mjs`
   - PASS
   - 48/48 tests passed
   - 0 failed

Frontend regression suite executed and results:

1. `node --test src/__tests__/coveragePlannerDetails.test.mjs src/__tests__/coveragePlannerUtils.test.mjs src/__tests__/salesCoverageDetails.test.mjs src/__tests__/salesCoverageReadiness.test.mjs src/__tests__/salesFeedbackMonitoring.test.mjs src/__tests__/tourRouteUtils.test.mjs src/__tests__/validationLabConfig.test.mjs`
   - PASS
   - 64/64 tests passed
   - 0 failed

Bug fixes in this cleanup:

- no backend bug fixes
- no business-rule bug fixes
- presentation-only cleanup in the normal Sales V2 planner

Known limitations after cleanup:

- backend monitoring and learning services remain available internally but are intentionally hidden from the normal Sales V2 planner UI
- development/validation tools such as Validation Lab remain code-available and are not part of the normal business workflow
- this Codex environment still required elevated Node execution because the sandbox blocks child-process spawning

## Post-freeze startup rebuild fix

Date: 2026-08-11

Scope:

- backend readiness/startup performance fix only
- no Smart Portfolio business semantics changed
- no frontend behavior changed
- no feedback / learning / promotion logic changed

Problem fixed:

- backend startup was unnecessarily triggering:
  - `Next Best Visit profile rebuild started in background at startup.`
- this could keep the normal Sales V2 UI in `Preparation en cours...` after every `node server.js` restart

Root cause:

- startup readiness and planner readiness had drifted into two different validity paths
- startup could treat a persisted READY snapshot as reusable under conditions that were not identical to the planner readiness check
- this inconsistency caused confusing behavior where startup looked ready but the planner could still enter `Preparation en cours...`

Fix implemented:

- removed the startup-only reuse path so startup and planner now evaluate the exact same persisted snapshot validity semantics
- a snapshot is now reused only when it is genuinely READY for the current source/schema/cadence state
- startup now skips rebuild only in that true-ready case and logs:
  - `Next Best Visit profiles already ready; startup rebuild skipped.`
- rebuild still triggers automatically only for real reasons:
  - snapshot missing
  - snapshot failed/corrupted
  - schema / cadence version mismatch
  - newer relevant source data

Files changed:

- `optimisation_tournee_api/next_best_visit_profile_snapshot_store.js`
- `optimisation_tournee_api/next_best_visit_profile_readiness.js`
- `optimisation_tournee_api/server.js`
- `optimisation_tournee_api/tests/next_best_visit_profile_readiness.test.cjs`

Focused tests executed and results:

1. `node --test tests/next_best_visit_profile_readiness.test.cjs`
   - PASS
   - 10/10 tests passed
   - 0 failed

Relevant backend regression pass:

1. `node --test tests/next_best_visit_profile_readiness.test.cjs tests/next_best_visit_service.test.cjs tests/next_best_visit_basket_loading.test.cjs tests/coverage_sales_coverage_integration.test.cjs`
   - PASS
   - 34/34 tests passed
   - 0 failed

Notes:

- server restart timestamp alone no longer invalidates profiles
- changing `planning_start_date` alone still does not make profiles stale
- Bloc 4C2A model/content versioning was not added to the profile-version identity
- the known non-blocking backend test log `Erreur SQL de connexion: Pool is closed.` may still appear while all assertions pass

## Final readiness version mismatch fix

Date: 2026-08-11

Scope:

- backend readiness/profile-version identity fix only
- no Smart Portfolio business semantics changed
- no learning / retraining / promotion logic changed
- no frontend workaround introduced

Problem fixed:

- a persisted READY profile snapshot could still appear as `building` from:
  - `GET /api/tournees/next-best-visits/readiness?start_date=...`
- the mismatch was visible as:
  - `profile_snapshot.version`
  - `profile_snapshot.required_version`
- this caused Sales V2 to re-enter `Preparation en cours...` for later planning dates even though the reusable snapshot was already valid

Exact root cause:

- the canonical profile version identity still depended on a planning-derived historical cutoff
- `planning_start_date` was being transformed into a day-minus-one cutoff during readiness evaluation
- that cutoff leaked into `required_profile_version`, so changing:
  - `2026-08-10`
  - `2026-08-11`
  - `2026-09-01`
  could produce different required versions even when:
  - source data was unchanged
  - profile schema was unchanged
  - cadence algorithm version was unchanged
- older persisted snapshots could also have a raw stored `profile_version` key that did not match the new canonical logical identity, even though the snapshot metadata itself was still valid

Fix implemented:

- profile-version identity is now computed from one canonical function reused by:
  - startup readiness
  - readiness endpoint
  - plan generation
- canonical identity now depends only on reusable profile semantics:
  - source-data version/fingerprint
  - profile schema version
  - cadence/profile algorithm version
  - explicit historical cutoff only when one is intentionally supplied and actually narrows the usable history
- canonical identity no longer changes just because:
  - `planning_start_date` changes
  - planning horizon changes
  - commercial selection changes
  - capacity/objective parameters change
- readiness now distinguishes:
  - logical canonical profile version
  - persisted storage profile version
- when a stored snapshot is semantically valid, planner readiness returns `ready` even if the legacy stored snapshot key differs from the canonical logical version
- plan generation loads the persisted snapshot by its actual stored version key while keeping cache/reporting identity tied to the canonical version
- automatic rebuild still occurs only for real stale reasons:
  - missing snapshot
  - failed/corrupted snapshot
  - newer relevant source data
  - profile schema change
  - cadence/profile algorithm version change

Files changed:

- `optimisation_tournee_api/next_best_visit_versions.js`
- `optimisation_tournee_api/next_best_visit_profile_snapshot_store.js`
- `optimisation_tournee_api/next_best_visit_profile_snapshot_rebuilder.js`
- `optimisation_tournee_api/next_best_visit_profile_readiness.js`
- `optimisation_tournee_api/next_best_visit_service.js`
- `optimisation_tournee_api/tests/next_best_visit_profile_readiness.test.cjs`

Focused tests executed and results:

1. `node --test tests/next_best_visit_profile_readiness.test.cjs`
   - PASS
   - 16/16 tests passed
   - 0 failed

2. `node --test src/__tests__/salesCoverageReadiness.test.mjs`
   - PASS
   - 6/6 tests passed
   - 0 failed

Relevant backend regression pass:

1. `node --test tests/next_best_visit_profile_readiness.test.cjs tests/next_best_visit_service.test.cjs tests/next_best_visit_basket_loading.test.cjs tests/coverage_sales_coverage_integration.test.cjs`
   - PASS
   - 47/47 tests passed
   - 0 failed

Key regressions now covered explicitly:

- same snapshot + different future `planning_start_date` => same required version
- same snapshot + different horizon/commercials/capacity/objective => same required version
- newer source data => different required version / rebuild
- profile schema change => different required version / rebuild
- cadence/profile algorithm change => different required version / rebuild
- readiness returns `ready` for multiple future dates without rebuild
- startup readiness and planner readiness compute the same canonical profile version
- frontend ready payload enables Generate immediately

Notes:

- changing `planning_start_date` alone no longer creates a different `required_version`
- startup and planner now share the same canonical profile-version identity
- model/prediction versioning remains outside profile snapshot identity unless the persisted client profile itself depends on it

## Orphaned building-state recovery fix

Date: 2026-08-11

Scope:

- backend readiness/rebuild coordinator fix only
- no Smart Portfolio business semantics changed
- no frontend workaround introduced
- no learning / retraining / promotion logic changed

Problem fixed:

- a persisted snapshot could remain stuck as:
  - `status = building`
  - `profile_snapshot.status = building`
- after the process that started the rebuild was already gone
- this left Sales V2 on `Preparation en cours...` indefinitely even when the old process no longer existed

Exact root cause:

- the persisted rebuild state was stored in SQL, but the real single-flight rebuild lock existed only in the live Node process
- after a restart or crash, the database could still say `rebuilding` while:
  - there was no in-flight rebuild promise in the current process
  - no real rebuild was still running
- the readiness coordinator trusted that persisted `building` flag too literally and could keep returning `building` forever
- after the canonical profile-version fix, one legitimate rebuild could be needed once, but an abandoned `building` flag could then block normal recovery for hours

Fix implemented:

- readiness now distinguishes between:
  - a real current-process in-flight rebuild
  - an orphaned persisted `building` state from a previous process
- if snapshot state is `building` but the current Node process has no in-flight rebuild promise:
  - the state is treated as abandoned
  - it is safely recovered to:
    - `stale` when a snapshot exists
    - `missing` when no snapshot exists
- a configurable rebuild timeout was added as an extra safeguard:
  - `NEXT_BEST_VISIT_PROFILE_REBUILD_TIMEOUT_MS`
  - default: 30 minutes, with a 60-second floor
- after recovery:
  - exactly one real rebuild starts if a rebuild is genuinely needed
  - concurrent readiness calls still reuse the same single-flight promise
- on successful rebuild:
  - state becomes `ready`
  - `active_profile_version` matches `required_profile_version`
  - `rebuilding_started_at` is cleared
  - `last_completed_at` is refreshed
- on failed rebuild:
  - state becomes `failed`
  - in-flight lock is cleared
  - later retry remains possible

Files changed:

- `optimisation_tournee_api/next_best_visit_profile_snapshot_store.js`
- `optimisation_tournee_api/next_best_visit_profile_readiness.js`
- `optimisation_tournee_api/tests/next_best_visit_profile_readiness.test.cjs`
- `HANDOFF_SALES_V2.md`

Focused tests executed and results:

1. `node --test tests/next_best_visit_profile_readiness.test.cjs`
   - PASS
   - 23/23 tests passed
   - 0 failed

2. `node --test src/__tests__/salesCoverageReadiness.test.mjs`
   - PASS
   - 6/6 tests passed
   - 0 failed

Key regressions now covered explicitly:

- persisted `building` + no in-flight job => recovered and one rebuild starts
- persisted `building` from a previous process is not reused as an active job
- active current-process rebuild is still reused as single-flight
- stale `building` timeout triggers recovery
- successful recovery returns to `ready`
- failed rebuild clears the lock and allows retry
- restart during rebuild is recovered automatically by the next process

Notes:

- the canonical profile-version fix remains intact
- startup/readiness/planner now share one canonical version identity and one recovery-safe rebuild coordinator
- frontend behavior remains unchanged and simply reflects the corrected backend readiness state

## Final planning-policy correction

Date:

- 2026-08-12

Scope:

- Sales V2 opportunity selection / assignment policy only
- no Smart Portfolio status semantics changed
- no prediction semantics changed
- no readiness / rebuild changed
- no feedback / learning / retraining changed
- no basket / loading changed
- no route optimization semantics changed

Exact previous defect:

- the daily target load (`Charge cible / commercial / jour`) acted only as a weak bonus
- generic score dominance could leave a day heavily underfilled even when many valid same-day candidates still existed
- in the reproduced live case for `Salah Ahmed (1)` on `2026-08-11`:
  - 41 clients had a valid date window including the day
  - all 41 were compatible with the selected commercial
  - only 11 were selected that day
  - 8 were shifted later
  - 22 were rejected outright with `LOW_EFFECTIVE_SCORE`
  - among those 22 rejections:
    - 11 were `due_now`
    - 11 were `due_soon`
- there was no max-capacity, compatibility, geography, or hard-constraint reason explaining that underfill

Final target-load semantics:

- the target is now a real soft fill objective, not just a tiny reporting bonus
- the maximum remains a hard constraint
- the planner now follows this effective hierarchy:
  1. respect hard constraints and valid date windows
  2. cover obligation-grade opportunities (`overdue`, `due_now`)
  3. reduce avoidable underfill relative to the target using valid `due_soon` opportunities
  4. maximize business priority / effective score among still-valid choices
  5. preserve multi-day balance and cadence quality
  6. route/order remains downstream from business selection

Tier / eligibility semantics:

- Tier A: obligation-grade
  - `overdue`
  - `due_now`
  - these are now ranked ahead of flexible opportunities
  - they are no longer discarded solely because of low score while capacity is still available

- Tier B: target-fill
  - `due_soon`
  - used to move underfilled days toward the configured target
  - still ranked by score, but the target now has a materially stronger influence

- Tier C: exploration
  - preserved under the existing exploration controls
  - low-signal exploration caps still apply
  - but they no longer block obligation-grade opportunities or due-soon target fill while the slot is still below target

- `not_due`
  - never scheduled just to fill the target

Changes made:

- `optimisation_tournee_api/visit_assignment_optimizer.js`
  - introduced tier-aware ranking:
    - `overdue`
    - `due_now`
    - `due_soon`
    - exploration
    - `not_due`
  - strengthened the under-target soft-fill bonus for valid `due_soon` opportunities
  - increased slot balancing pressure for flexible `due_soon` opportunities
  - added tier-aware slot selection so underfilled slots are preferred for target-fill opportunities
  - preserved hard daily maximum
  - preserved exploration repeat guards and duplicate-cycle prevention
  - prevented `not_due` opportunities from being used as target filler

- `optimisation_tournee_api/next_best_visit_engine.js`
  - propagated pre-assignment `portfolio_status` / due semantics into opportunities so assignment can separate:
    - eligibility
    - ranking
  - mapped `LOW_EFFECTIVE_SCORE` deferred outcomes to a classified deferred status instead of allowing them to fall into `other_unclassified`

- `optimisation_tournee_api/tests/next_best_visit_assignment_target_policy.test.cjs`
  - added deterministic policy tests for:
    - target fill
    - valid under-target shortage
    - obligation retention
    - hard max
    - multi-day balancing
    - no `not_due` fill

Real Salah Ahmed diagnostic — before vs after:

Reproduced request:

- `planning_start_date = 2026-08-11`
- commercial = `Salah Ahmed (1)`
- target = `30`
- max = `40`
- 14-day horizon

Before:

- active clients considered: `517`
- due_now: `22`
- overdue: `132`
- due_soon: `182`
- not_due: `181`
- day-eligible on `2026-08-11`: `41`
- obligation-grade day-eligible (`overdue + due_now`): `25`
- flexible day-eligible (`due_soon`): `16`
- selected on `2026-08-11`: `11`
- shifted later inside same valid window: `8`
- rejected from same-window pool: `22`
- rejection reasons:
  - `LOW_EFFECTIVE_SCORE = 22`
- rejected-by-status:
  - `due_now = 11`
  - `due_soon = 11`
- total planned visits across the horizon: `90`
- suspicious repeats: `0`
- elapsed generation time: `2824 ms`

After:

- active clients considered: `517`
- due_now: `22`
- overdue: `132`
- due_soon: `182`
- not_due: `181`
- day-eligible on `2026-08-11`: `41`
- obligation-grade day-eligible (`overdue + due_now`): `25`
- flexible day-eligible (`due_soon`): `16`
- selected on `2026-08-11`: `17`
- shifted later inside same valid window: `32`
- rejected from same-window pool: `0`
- rejection reasons:
  - none from the same-window pool
- selected on `2026-08-11` by status:
  - `due_now = 15`
  - `due_soon = 2`
- shifted later by status:
  - `overdue = 3`
  - `due_now = 15`
  - `due_soon = 14`
- daily loads across the horizon:
  - `2026-08-11 = 17`
  - `2026-08-12 = 17`
  - `2026-08-13 = 18`
  - `2026-08-14 = 17`
  - `2026-08-15 = 18`
  - `2026-08-16 = 18`
  - `2026-08-17 = 18`
  - `2026-08-18 = 18`
  - `2026-08-19 = 17`
  - `2026-08-20 = 18`
  - `2026-08-21 = 18`
  - `2026-08-22 = 17`
  - `2026-08-23 = 17`
  - `2026-08-24 = 16`
- total planned visits across the horizon: `244`
- target utilization:
  - day 1 = `17 / 30 = 56.7%`
  - horizon total = `244 / 420 = 58.1%`
- max-capacity violations: `0`
- suspicious repeats: `0`
- elapsed generation time: `992 ms`

Remaining legitimate underfill reasons:

- there is no longer a same-window `LOW_EFFECTIVE_SCORE` discard problem on the reproduced day
- the remaining underfill is now driven by horizon-wide balancing over a limited total valid visit volume:
  - target horizon capacity = `14 x 30 = 420`
  - actual selected visits = `244`
- because the total valid visit volume is well below the horizon target capacity, the optimizer distributes valid visits across the horizon rather than front-loading one day to 30
- this means the reproduced underfill is now expected by the current design:
  - the target materially influences assignment
  - but it does not override legitimate cross-horizon balancing when the total valid visit pool is insufficient to sustain the requested daily target

Performance before / after:

- reproduced live request before: `2824 ms`
- reproduced live request after: `992 ms`

Focused tests executed and results:

1. `node --test tests/next_best_visit_assignment_target_policy.test.cjs tests/next_best_visit_phase_d4.test.cjs tests/next_best_visit_phase_d5.test.cjs`
   - PASS
   - 20/20 tests passed
   - 0 failed

Final regression executed and results:

1. `node --test tests/client_identity_resolution.test.cjs tests/coverage_capacity_policy.test.cjs tests/coverage_constraints_provider.test.cjs tests/coverage_sales_coverage_integration.test.cjs tests/next_best_visit_assignment_target_policy.test.cjs tests/next_best_visit_smart_portfolio_core.test.cjs tests/next_best_visit_phase_d2.test.cjs tests/next_best_visit_phase_d3.test.cjs tests/next_best_visit_phase_d4.test.cjs tests/next_best_visit_phase_d5.test.cjs tests/next_best_visit_service.test.cjs tests/next_best_visit_validation_lab.test.cjs`
   - PASS
   - 73/73 tests passed
   - 0 failed

2. `node tests/run_next_best_visit_validation_lab.cjs`
   - PASS
   - 25/25 scenarios passed
   - 0 failed
   - 0 critical failures
   - deterministic = `true`
   - benchmarks:
     - `100 clients / 7 jours = 40 ms`
     - `1000 clients / 14 jours = 450 ms`
     - `5768 clients / 14 jours = 1684 ms`
     - `5768 clients / 30 jours = 2194 ms`

Explicit post-fix validation summary:

- no invented visits
- no max-capacity violation
- no `not_due` fill
- `overdue` / `due_now` are no longer discarded from the reproduced same-day pool solely because of `LOW_EFFECTIVE_SCORE`
- target now materially influences assignment
- D4 flexibility remains valid
- D5 cycle / repeat protection remains valid
- `suspicious_repeat_count` remained `0` in the reproduced live case
- portfolio coverage remained 100%

Remaining legitimate underfill reasons:

- the horizon-level target remains underfilled when the total valid visit pool is smaller than the requested target capacity
- in the reproduced live case:
  - horizon target capacity = `420`
  - actual selected visits = `244`
- after the fix, the optimizer no longer discards valid same-window candidates on day 1 for low score
- the remaining day-1 underfill is therefore explained by:
  - horizon-wide balancing
  - a total valid visit pool that is insufficient to sustain `30` visits every day across the whole horizon

## Architecture Migration - Phase 1

Scope:

- This begins the data/feature architecture migration whose goal is to decouple:
  - data freshness
  - model retraining
- No serving switch has happened yet in this phase.
- Smart Portfolio, assignment policy, feedback semantics, and model/promotion safety are unchanged.

Phase 1 outcome:

- Extracted one reusable canonical Python feature-engineering module:
  - `optimisation_tournee_api/nomadis_feature_engineering.py`
- Refactored `optimisation_tournee_api/train_auto.py` to reuse that canonical module instead of maintaining a second in-file copy of the feature formulas.

Canonical feature engine currently centralizes:

- feature column definitions
- categorical column definitions
- feature schema signature/version
- MySQL base extraction queries
- dense client/day panel construction
- derived historical feature calculations
- default-filling semantics
- demand-history export helpers
- preference-frame extraction
- canonical bundle construction from MySQL as-of a cutoff date

Feature-engineering semantics preserved in the canonical module:

- `days_since_last_order`
- `vente_last`
- `qte_last`
- `vente_avg_3`
- `qte_avg_3`
- CA / quantity / orders over `7d / 30d / 60d / 90d`
- average CA / quantity / docs / line items / product refs per order
- weekday purchase behavior
- same-weekday recency
- order-gap features
- recent trend features
- historical price
- categorical client geography / routing / commercial fields

Important extraction fix discovered and corrected during Phase 1:

- The fresh MySQL extraction query in the newly extracted canonical module initially returned zero rows because SQL date-format strings had been over-escaped (`%%Y-%%m-...`) in the reusable query path.
- This was corrected to the real MySQL `STR_TO_DATE(..., '%Y-%m-%d %H:%i:%s')` format.
- This is a real bug fix in the fresh data extraction path, not a change of business semantics.

Parity-specific correction made in the canonical builder:

- The historical training CSV was built with:
  - global panel date calendar semantics
  - global outlier-cap filtering
  - global default-fill medians
- A subset-only rebuild would drift if it used:
  - only subset dates
  - only subset quantile caps
  - only subset default medians
- The canonical builder was therefore corrected so a subset build can still reuse:
  - global calendar dates
  - global quantile caps
  - global default-fill values

Known parity limitation identified:

- The old `dataset_features_clients_jour.csv` is not a perfect immutable parity oracle for every client anymore because the current MySQL contents have drifted since that CSV was generated.
- Example:
  - client `00003` shows historical-count / price-feature mismatches between the old CSV and current MySQL-derived rebuild
  - this appears to come from database-history drift after the CSV snapshot was created, not from the extracted formulas themselves
- Phase 1 parity validation therefore uses stable historical rows that still match the current database state.

Focused Phase 1 tests executed and results:

1. `python -m py_compile optimisation_tournee_api/nomadis_feature_engineering.py optimisation_tournee_api/train_auto.py optimisation_tournee_api/tests/test_nomadis_feature_engineering.py`
   - PASS

2. `python optimisation_tournee_api/tests/test_nomadis_feature_engineering.py`
   - PASS
   - 3/3 tests passed
   - validates:
     - canonical feature schema version presence
     - exact client-code / leading-zero preservation
     - parity against stable historical rows already present in the legacy CSV (`00002` on `2025-01-01`, `2025-10-03`, `2026-07-15`)

Files changed in Phase 1:

- `optimisation_tournee_api/nomadis_feature_engineering.py`
- `optimisation_tournee_api/train_auto.py`
- `optimisation_tournee_api/tests/test_nomadis_feature_engineering.py`

Next step:

- Phase 2 - build a persistent feature store with strict as-of semantics and refresh coordination

## Architecture Migration - Phase 2/3/4

Scope:

- Phase 2/3/4 stabilizes the new serving-side freshness architecture without changing:
  - Smart Portfolio semantics
  - assignment policy
  - feedback semantics
  - promotion / rollback safety
  - prediction target meanings
- Candidate learning and the green-button full retrain flow are not migrated yet in this checkpoint.

Phase 2/3/4 outcome:

- Added a persistent canonical feature-store module:
  - `optimisation_tournee_api/nomadis_feature_store.py`
- Started switching live Flask serving to that feature store in:
  - `optimisation_tournee_api/api_ia.py`

Current canonical serving path after this checkpoint:

1. source watermark is computed from real MySQL commercial transactions
2. canonical feature rows are materialized into:
   - `nomadis_client_feature_store`
   - `nomadis_feature_store_state`
3. Flask loads active feature-store rows as the normal historical serving source
4. requests resolve an as-of cutoff using:
   - `prediction_date - 1 day`
   - capped by the latest legitimate active source date
5. only if the canonical feature store is unavailable does Flask fall back to:
   - `dataset_features_clients_jour.csv`
   - and that fallback is explicitly marked as `csv_fallback`

New persistent feature-store schema:

- rows table: `nomadis_client_feature_store`
  - keyed by:
    - `feature_state_version`
    - `client_code`
    - `date_doc`
  - stores:
    - canonical historical feature columns
    - source watermark
    - feature schema version
    - source max date
    - computed timestamp
- state table: `nomadis_feature_store_state`
  - tracks:
    - active feature schema/version
    - active source watermark
    - active source max date
    - active row/client counts
    - status
    - rebuild reason
    - rebuild timestamps
    - last error

Source watermark semantics:

- The source watermark is built from real MySQL commercial source state only, bounded by the legitimate serving upper bound date.
- It currently includes:
  - feature schema version
  - serving upper-bound date
  - source max date
  - transaction count
  - client count
  - transaction-day count
  - total net amount
  - max document code
- A backend restart alone does not change it.

Strict as-of serving rule now implemented:

- For prediction date `D`, serving features must use data no later than:
  - `D - 1 day`
- The effective cutoff is:
  - `min(prediction_date - 1 day, active_source_max_date)`
- This prevents future-dated DB rows from leaking backwards into earlier predictions.

Important serving bug fixed in this phase:

- Even when Flask successfully loaded canonical feature-store history, it was still deriving `df_daily_demand` through the old CSV-preferred helper.
- This meant budget-related serving behavior could still inherit stale `daily_demand_history.csv`.
- Fix:
  - canonical feature-store runtime now builds daily demand directly from the loaded feature-store history (`prefer_csv=False`)
  - CSV remains secondary fallback only

Refresh / coordination behavior currently implemented:

- Single-flight refresh in Flask:
  - one in-process feature refresh at a time
  - concurrent callers reuse the same refresh thread/promise path
- Startup:
  - if active feature state is current, reuse immediately
  - if stale but an active snapshot exists, load it and schedule background refresh
  - if no active snapshot exists, bootstrap synchronously once
- Background scheduler:
  - delayed startup check
  - periodic interval freshness checks
- Abandoned building states:
  - persisted `building` states older than the configured timeout are treated as expired and recovered

Serving metadata now exposed internally by Flask:

- `prediction_history_source`
  - normally `canonical_feature_store`
  - fallback `csv_fallback`
- `history_cutoff_date`
- `feature_schema_version`
- `source_data_watermark`
- `feature_store_state`

Focused Phase 2/3/4 tests executed and results:

1. `python -m py_compile optimisation_tournee_api/api_ia.py optimisation_tournee_api/nomadis_feature_store.py optimisation_tournee_api/tests/test_nomadis_feature_store.py`
   - PASS

2. `python -m unittest optimisation_tournee_api.tests.test_nomadis_feature_store`
   - PASS
   - 6/6 tests passed
   - validates:
     - active snapshot / watermark currentness semantics
     - strict `prediction_date - 1 day` cutoff semantics
     - no future leakage even when source max date is later
     - canonical runtime uses feature-store history rather than CSV-preferred daily-demand loading
     - serving metadata reports `canonical_feature_store`
     - refresh scheduler skips when current and recovers expired persisted `building` state

Files changed in Phase 2/3/4:

- `optimisation_tournee_api/nomadis_feature_engineering.py`
- `optimisation_tournee_api/nomadis_feature_store.py`
- `optimisation_tournee_api/api_ia.py`
- `optimisation_tournee_api/tests/test_nomadis_feature_store.py`

Known limitation after this checkpoint:

- Sales V2 candidate retraining still depends on historical state loaded from `dataset_features_clients_jour.csv`.
- The green-button/manual full retrain flow still owns the normal CSV export lifecycle.
- Those are the next migration steps, not yet complete in this phase.

Next step:

- Phase 5/6 - migrate candidate learning and the manual full retrain flow to the canonical feature-store semantics while preserving current promotion/rollback safety

## Architecture Migration - Phase 5/6A

Scope of this checkpoint:

- Continue the architecture migration without changing:
  - Smart Portfolio business semantics
  - Sales V2 assignment policy
  - Recouvrement
  - prediction target meanings
  - feedback semantics
  - candidate evaluation / promotion / rollback safety rules

Phase 5/6A outcome:

- Sales V2 candidate-learning and promotion metadata now derive the live serving feature identity from the canonical feature-store state instead of trusting an ad hoc or stale features-version value.
- Candidate historical training input no longer uses `dataset_features_clients_jour.csv` as its canonical historical base.
- Candidate learning now reads the active canonical feature-store frame through:
  - `optimisation_tournee_api/train_candidate_feedback.py`
  - `optimisation_tournee_api/nomadis_feature_store.py`
- Promotion / rollback verification now remains aligned with the same canonical serving-version semantics already used by the feature-store-first Flask serving path.

Exact root cause fixed in this phase:

- The migration had partially switched serving identity from CSV-artifact hashes to canonical feature-store identity, but one learning/promotion path still accepted a caller-side `features_version` instead of recomputing the canonical serving version from:
  - `feature_schema_version`
  - `feature_state_version`
  - `source_data_watermark`
- This created a false mismatch during promotion verification:
  - current model metadata recomputed the canonical serving version
  - mocked / persisted candidate-learning expectations could still carry a non-canonical value
  - promotion then failed even though the model / feature-store semantics were compatible
- The fix was to make `sales_learning_candidate_service.js` always compute `features_version` through the canonical helper:
  - `buildCanonicalServingFeaturesVersion(...)`

Files changed in Phase 5/6A:

- `optimisation_tournee_api/sales_learning_candidate_service.js`
- `optimisation_tournee_api/train_candidate_feedback.py`
- `optimisation_tournee_api/next_best_visit_versions.js`
- `optimisation_tournee_api/next_best_visit_service.js`
- `optimisation_tournee_api/tests/sales_learning_candidate_service.test.cjs`
- `optimisation_tournee_api/tests/sales_learning_promotion_service.test.cjs`
- `optimisation_tournee_api/tests/sales_learning_automatic_cycle.test.cjs`
- `HANDOFF_SALES_V2.md`

Focused Phase 5/6A tests executed and results:

1. `node --test tests/sales_learning_candidate_service.test.cjs tests/sales_learning_promotion_service.test.cjs tests/sales_learning_automatic_cycle.test.cjs`
   - PASS
   - 17/17 tests passed
   - 0 failed

Validated behaviors in this checkpoint:

- insufficient new feedback still does not start automatic learning
- enough new feedback starts one cycle only
- same feedback does not retrigger endlessly
- concurrent automatic checks reuse the same in-flight cycle
- failed training leaves the current model untouched
- candidate training payload remains deterministic and preserves exact client codes
- better candidate still promotes safely
- worse candidate still keeps the current model
- rollback still restores the previous archived version

Known limitation after this checkpoint:

- The green-button/manual full retrain flow still needs an explicit final migration pass so that its documented role becomes:
  - force canonical feature refresh
  - optional CSV export regeneration
  - full production retraining
  - reload
- The full architecture migration is therefore not finished at this checkpoint.

Next step:

- Complete Phase 5 manual full-retrain alignment, then validate client `00158`, representative client freshness, temporal backtest, performance, and the final full regression pass.

## Architecture Migration - Phase 5/6B

Scope of this checkpoint:

- Finish the manual full-retrain / green-button alignment without changing:
  - Smart Portfolio business semantics
  - Sales V2 assignment policy
  - Recouvrement
  - prediction target meanings
  - feedback semantics
  - candidate evaluation / promotion / rollback safety rules

Phase 5/6B outcome:

- `optimisation_tournee_api/train_auto.py` now explicitly synchronizes the canonical feature store during the same manual full-retrain flow triggered by the green button.
- The admin/manual full retrain path is now:
  - fresh MySQL extraction
  - canonical feature engineering
  - CSV/export artifact regeneration
  - full production XGBoost retraining
  - canonical feature-store persistence for serving freshness
  - Flask reload handled by the existing Node endpoint
- `dataset_features_clients_jour.csv` remains exported as a reproducible audit/training artifact, but the stale legacy comment that described it as the realtime serving source has been corrected.

Exact root cause fixed in this phase:

- The migration had already switched normal Flask serving to the canonical feature store, but the manual full-retrain path still behaved like the old architecture:
  - rebuild CSV
  - retrain models
  - leave feature-store refresh implicit
- That meant the documented architecture and the operational green-button flow were still partially divergent.
- The fix was to make `train_auto.py` explicitly:
  - resolve a serving cutoff through `resolve_serving_data_upper_bound_date()`
  - build a canonical serving bundle via `build_canonical_feature_bundle(...)`
  - compute a source watermark through `build_feature_store_source_summary(...)`
  - persist the resulting canonical serving snapshot through `persist_feature_store_snapshot(...)`

Files changed in Phase 5/6B:

- `optimisation_tournee_api/train_auto.py`
- `HANDOFF_SALES_V2.md`

Focused Phase 5/6B tests executed and results:

1. `python -m py_compile optimisation_tournee_api/train_auto.py optimisation_tournee_api/nomadis_feature_engineering.py optimisation_tournee_api/nomadis_feature_store.py`
   - PASS
   - 0 compilation errors

2. `python -m unittest optimisation_tournee_api.tests.test_nomadis_feature_engineering optimisation_tournee_api.tests.test_nomadis_feature_store`
   - PASS
   - 9/9 tests passed
   - 0 failed

Validated behaviors in this checkpoint:

- canonical feature-engineering parity remains intact
- feature-store serving semantics remain intact
- as-of cutoff still uses `prediction_date - 1 day` bounded by source freshness
- persisted feature-store state still recovers abandoned `building` states safely
- the manual full-retrain path now refreshes the canonical serving store as part of the same administrative operation

Known limitation after this checkpoint:

- End-to-end freshness validation against the real `00158` case and the representative client sample has not been rerun yet after the green-button alignment.
- Temporal backtest, measured performance validation, and the one-time final full regression pass are still pending.

Next step:

- Validate client `00158`, representative client freshness, temporal backtest, performance, and then run the final one-time relevant regression pass.

## Architecture Migration - Phase 5/6C

Scope of this checkpoint:

- Finish the remaining live-serving migration gap without changing:
  - Smart Portfolio business semantics
  - Sales V2 assignment policy
  - Recouvrement
  - prediction target meanings
  - feedback semantics
  - candidate evaluation / promotion / rollback safety rules

Phase 5/6C outcome:

- The canonical feature store was already the primary history source for live serving, but one request-time branch still used a globally cached preferences frame built for the active feature-store cutoff rather than the prediction request cutoff.
- `optimisation_tournee_api/api_ia.py` now resolves preferences through `get_preferences_frame_for_cutoff(history_cutoff_date, engine=feature_store_engine)` inside `predict_tournee()` and passes that exact cutoff-scoped frame into `build_dashboard_prediction_output(...)`.
- This keeps the dashboard-style prediction output aligned with the same request-specific historical cutoff already used by:
  - canonical feature selection
  - batch scoring
  - expected CA / quantity derivation
- The serving path now preserves one consistent request-time historical context instead of mixing:
  - canonical feature-store client history for scoring
  - global active-cutoff preference history for product-weight output formatting

Exact root cause fixed in this phase:

- The architecture migration had already removed CSV as the normal serving source, but the request pipeline still had one stale-serving seam:
  - `build_scored_prediction_candidates(...)` used the correct request cutoff
  - `build_dashboard_prediction_output(...)` could still default to global `df_prefs`
- That meant live response details could silently drift from the same canonical request cutoff used for the model inputs.
- The fix was to make `predict_tournee()` explicitly pass request-cutoff-scoped preferences into the output builder.

Files changed in Phase 5/6C:

- `optimisation_tournee_api/api_ia.py`
- `optimisation_tournee_api/tests/test_nomadis_feature_store.py`
- `HANDOFF_SALES_V2.md`

Focused Phase 5/6C tests executed and results:

1. `python -m py_compile optimisation_tournee_api/api_ia.py optimisation_tournee_api/nomadis_feature_store.py optimisation_tournee_api/nomadis_feature_engineering.py optimisation_tournee_api/train_candidate_feedback.py optimisation_tournee_api/train_auto.py`
   - PASS
   - 0 compilation errors

2. `python -m unittest optimisation_tournee_api.tests.test_nomadis_feature_store optimisation_tournee_api.tests.test_nomadis_feature_engineering`
   - PASS
   - 12/12 tests passed
   - 0 failed

Validated behaviors in this checkpoint:

- canonical feature-engineering parity remains intact
- live serving still uses the canonical feature store as its normal historical source
- request-time prediction now carries one consistent historical cutoff into dashboard-formatted output
- feature-store currentness and target-date horizon checks remain intact
- abandoned persisted `building` states still recover safely

Known limitation after this checkpoint:

- Real-data freshness validation for client `00158`, the representative sample sweep, temporal backtest, and measured performance checks are still pending.
- The final one-time regression pass is still pending.

Next step:

- Run client `00158` before/after validation, representative freshness validation, temporal backtest, measured performance checks, and the final one-time relevant regression pass.

## Architecture Migration - Phase 5/6D

Scope of this checkpoint:

- Stabilize the canonical feature-store migration before live validation by fixing:
  - duplicate client/day rows preventing persisted feature-store materialization
  - source-watermark metadata drift that made the feature store look empty even when the canonical builder had real source rows

Phase 5/6D outcome:

- `optimisation_tournee_api/nomadis_feature_engineering.py`
  - `normalize_base_dataset(...)` now collapses duplicate `(client_code, date_doc)` rows before canonical panel expansion.
  - Aggregation semantics are additive for same-day transactional totals:
    - `ca_jour`, `qte_jour`, `docs_jour`, `line_items_jour`, `product_refs_jour` -> `sum`
    - client-level categorical identity fields keep the stable `first` value
    - `potentiel` keeps the `max` value
- This fixed the real materialization blocker:
  - duplicate key on `nomadis_client_feature_store_unique`
  - concrete reproduced duplicate:
    - `client_code = CLT00`
    - `date_doc = 2026-02-11`
- `optimisation_tournee_api/nomadis_feature_store.py`
  - `build_feature_store_source_summary(...)` now correctly reads the SQL result row instead of silently leaving `row = None`.
  - The persisted source summary / watermark now reflects the real source query rather than an all-zero fallback.
- `optimisation_tournee_api/tests/test_nomadis_feature_engineering.py`
  - parity tolerance was slightly relaxed for floating-point comparisons after same-day duplicate collapsing
  - added explicit duplicate-collapse regression coverage
- `optimisation_tournee_api/tests/test_nomadis_feature_store.py`
  - added regression coverage ensuring source-summary metadata preserves the real SQL counts/max date

Exact root causes fixed in this phase:

1. Canonical feature-store persistence could fail even though canonical feature generation succeeded:
   - the builder emitted at least one duplicate `(client_code, date_doc)` row
   - persistence then failed on the unique key for the feature-store table

2. Source-watermark metadata could incorrectly report:
   - `txn_count = 0`
   - `client_count = 0`
   - `source_max_date = null`
   even when the underlying SQL query returned valid source rows
   - because the query result was assigned to `result` while the code still read from `row`

Files changed in Phase 5/6D:

- `optimisation_tournee_api/nomadis_feature_engineering.py`
- `optimisation_tournee_api/nomadis_feature_store.py`
- `optimisation_tournee_api/tests/test_nomadis_feature_engineering.py`
- `optimisation_tournee_api/tests/test_nomadis_feature_store.py`
- `HANDOFF_SALES_V2.md`

Focused Phase 5/6D tests executed and results:

1. `python -m py_compile optimisation_tournee_api/nomadis_feature_store.py optimisation_tournee_api/tests/test_nomadis_feature_store.py`
   - PASS
   - 0 compilation errors

2. `python -m unittest optimisation_tournee_api.tests.test_nomadis_feature_engineering optimisation_tournee_api.tests.test_nomadis_feature_store`
   - PASS
   - 14/14 tests passed
   - 0 failed

Validated behaviors in this checkpoint:

- canonical feature parity remains green on the reference CSV sample
- duplicate same-day source rows are normalized before feature-store persistence
- canonical feature-store persistence can complete successfully
- persisted source watermark metadata now reflects the real SQL source state instead of false zeroes

Remaining work after this checkpoint:

- re-run the active feature-store refresh so the persisted state uses the corrected source summary metadata
- validate the real `00158` case before/after the migration
- run representative freshness validation, temporal backtest, performance checks, and the final one-time regression pass

Next step:

- refresh the persisted feature-store state with the corrected watermark metadata, then validate client `00158` end to end.

## Architecture Migration - Final validation and freeze status

This section supersedes the previously pending Phase 5/6D follow-up items.

Final validated status:

- `canonical_feature_store` is implemented and active for live prediction.
- Real client `00158` freshness validation passed.
- Request cutoff semantics passed:
  - prediction date `D` uses data only up to `D-1`
  - future-dated source rows are excluded from historical prediction
- Representative freshness sweep passed `31/32`.
- Client `05987` remains one isolated data/freshness caveat and is the only representative-sample exception kept open in the freeze notes.
- Temporal backtest completed successfully.

Temporal backtest verdict:

- `partially valid`
- `metrics_by_strategy.v2` validates the core V2 scoring + assignment benchmark.
- The historical full service path can still be blocked by stale retrospective profile snapshots.
- This means the temporal backtest is valid for core ranking / assignment benchmarking, but not a complete proof that every retrospective window executed the full end-to-end executable planner service path.

Temporal backtest aggregated V2 metrics:

- `precision_at_capacity = 8.97%`
- `buyer_recall = 21.3%`
- `cadence_due_hit_rate = 24%`
- `frequent_client_repeat_detection_rate = 63.13%`
- average end-to-end service runtime `~= 304.67 ms`

Interpretation of the backtest ranking result:

- V2 beats random/recency on the core business metrics captured by the benchmark.
- V2 is not the top pure purchase classifier.
- This is expected because V2 balances:
  - cadence
  - due status
  - assignment constraints
  - planning constraints
  rather than optimizing only purchase probability.

Historical-service backtest reporting fix completed:

- When the historical service payload exits early because the retrospective profile snapshot is stale, the backtest now reports:
  - `v2_selected_visits_count = null`
  - `v2_service_validation_status = "not_executed_snapshot_stale"`
- This reporting fix changes only backtest interpretation.
- No production/business planning logic changed:
  - no Sales V2 planning logic change
  - no scoring change
  - no assignment optimizer change
  - no profile/readiness semantic change
  - no feature-store change
  - no prediction-model change
  - no production service behavior change

Focused validation executed after the reporting fix:

1. `node --test tests/next_best_visit_phase_b.test.cjs`
   - PASS
   - `6/6` tests passed
   - validated:
     - stale historical service payload -> `v2_selected_visits_count = null`
     - successful service payload -> selected count matches service summary

Final Python regression executed and results:

1. `python -m unittest optimisation_tournee_api.tests.test_nomadis_feature_engineering optimisation_tournee_api.tests.test_nomadis_feature_store optimisation_tournee_api.tests.test_train_candidate_feedback`
   - PASS
   - `18/18` tests passed
   - covered:
     - `test_nomadis_feature_engineering`
     - `test_nomadis_feature_store`
     - `test_train_candidate_feedback`

Commercial-validation / data-quality note:

- The dev database still contains invalid and future-dated records.
- The canonical as-of cutoff logic correctly excludes future data for historical prediction.
- Do not claim commercial validation from this development dataset.

Freeze status:

- Migration status: technically validated and ready to freeze.
- Documented caveat retained:
  - isolated `05987` data-quality / freshness caveat
- Final freeze interpretation:
  - architecture migration complete
  - live freshness path validated
  - request cutoff semantics validated
  - temporal backtest completed with the documented partial-validity limitation
