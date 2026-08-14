# Audit Plan De Couverture vs cible Laravel 10+

Date d'audit: 2026-07-28

## Etat actuel du repository

- Backend HTTP principal: `Node.js / Express` dans `optimisation_tournee_api/server.js`
- Solveur metier: `Python / Flask + OR-Tools` dans `optimisation_tournee_api/api_ia.py` et `optimisation_tournee_api/coverage_optimizer.py`
- Frontend: `React / Vite` dans `optimisation_tournee_front`
- Migration SQL existante: `optimisation_tournee_api/migrations/001_create_client_visits.sql`

## Ecart avec l'architecture cible Laravel 10+

### 1. Couche API
- Actuel: routes Express directement dans `server.js`
- Cible Laravel: `routes/api.php` + controllers dedies
- Ecart: pas de controllers Laravel, pas de Form Requests, pas de Resources API

### 2. Couche service metier
- Actuel: orchestration coverage melangee dans `server.js`
- Cible Laravel: services dedies du type:
  - `CoveragePlanningService`
  - `CoverageFeasibilityService`
  - `PythonCoverageOptimizerClient`
  - `CoverageResultFormatter`
- Ecart: l'orchestration n'est pas encore decoupee en services PHP

### 3. Couche persistence
- Actuel: SQL brut + helper `queryAsync`
- Cible Laravel: migrations PHP + Eloquent/Query Builder
- Ecart: les tables ne sont pas gerees par des migrations Laravel 10+, et le module coverage ne dispose pas encore d'une couche modele Laravel

### 4. Couche execution asynchrone
- Actuel: appels HTTP synchrones Node -> Flask
- Cible Laravel: `Jobs`, `Queues`, retriable failures, tracing applicatif
- Ecart: pas de job Laravel pour les executions lourdes coverage

### 5. Validation applicative
- Actuel: validation cote Node et validation independante cote Python
- Cible Laravel: `FormRequest` + validateurs/services complementaires
- Ecart: la validation n'est pas encore centralisee dans la couche Laravel

## Decision prise dans cette livraison

Vu que le repository ne contient pas encore d'application Laravel 10+ executable, la correction reelle de la logique coverage a ete implemente directement dans l'architecture existante, sans casser la production actuelle:

- endpoint d'analyse de faisabilite coverage
- endpoint de generation coverage
- solveur Python OR-Tools
- validations independantes
- simplification forte du frontend

## Prochaine etape de migration recommandee

1. Creer le projet Laravel 10+ qui deviendra le backend principal.
2. Extraire l'orchestration coverage de `server.js` vers des services Laravel.
3. Conserver `coverage_optimizer.py` comme micro-service Python appele par Laravel.
4. Migrer les tables SQL critiques en migrations Laravel PHP.
5. Remplacer progressivement les routes Express par des controllers Laravel.
