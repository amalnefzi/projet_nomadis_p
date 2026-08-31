from flask import Flask, request, jsonify
import pandas as pd
import joblib
import numpy as np
import sys
import os
import json
import uuid
import hashlib
import math
import time
import threading
from pathlib import Path
from datetime import datetime
from sqlalchemy import create_engine

from nomadis_feature_engineering import (
    FEATURE_SCHEMA_VERSION as CANONICAL_FEATURE_SCHEMA_VERSION,
    build_preferences_frame,
    get_mysql_url,
)
from nomadis_feature_store import (
    FEATURE_STORE_BUILD_TIMEOUT_SECONDS,
    build_feature_store_source_summary,
    compute_effective_history_cutoff,
    ensure_feature_store_tables,
    feature_store_build_expired,
    feature_store_covers_target_date,
    feature_store_is_current,
    load_active_feature_store_frame,
    read_feature_store_state,
    refresh_feature_store,
)
from nomadis_model_strategy import (
    build_historical_baselines,
    extract_precision_score,
    load_strategy,
    resolve_target_choice,
)

try:
    from dotenv import load_dotenv as python_dotenv_load
except Exception:  # pragma: no cover
    python_dotenv_load = None

app = Flask(__name__)
BASE_DIR = Path(__file__).resolve().parent
CLIENT_CODE_CSV_DTYPE = {"client_code": "string"}

FEATURE_COLUMNS_BASE = [
    'jour_semaine',
    'day_of_month',
    'week_of_month',
    'days_to_month_end',
    'is_month_start',
    'is_month_end',
    'potentiel',
    'nbr_visites_hist',
    'nbr_visites_jour',
    'days_since_last_order',
    'vente_last',
    'qte_last',
    'docs_last',
    'line_items_last',
    'product_refs_last',
    'vente_avg_3',
    'qte_avg_3',
    'docs_avg_3',
    'line_items_avg_3',
    'product_refs_avg_3',
    'ca_last_7d',
    'ca_last_30d',
    'ca_last_60d',
    'ca_last_90d',
    'qte_last_7d',
    'qte_last_30d',
    'qte_last_60d',
    'qte_last_90d',
    'docs_last_30d',
    'docs_last_90d',
    'line_items_last_30d',
    'line_items_last_90d',
    'product_refs_last_30d',
    'product_refs_last_90d',
    'orders_last_7d',
    'orders_last_30d',
    'orders_last_60d',
    'orders_last_90d',
    'avg_ca_per_order_90d',
    'avg_qte_per_order_90d',
    'avg_docs_per_order_90d',
    'avg_line_items_per_order_90d',
    'avg_product_refs_per_order_90d',
    'weekday_purchase_rate',
    'days_since_last_same_weekday_order',
    'days_between_last_orders',
    'avg_days_between_orders_5',
    'order_gap_ratio',
    'recent_ca_trend',
    'recent_qte_trend',
    'avg_price_hist',
    'month'
]

MAIN_CATEGORICAL_COLUMNS = [
    'region',
    'delegation',
    'routing_code',
    'home_commercial'
]

ASSIGNMENT_CATEGORICAL_COLUMNS = [
    'client_code',
    'region',
    'delegation',
    'routing_code',
    'home_commercial'
]

model_achat = None
model_ca = None
model_qte = None
model_price = None
model_affectation = None
feature_columns = []
assignment_feature_columns = []
assignment_classes = []
df_master = pd.DataFrame()
prediction_history_source = None
df_daily_demand = pd.DataFrame()
df_prefs = pd.DataFrame(columns=['client_code', 'produit_nom', 'produit_code', 'qte_moyenne'])
preferences_cache = {}
feature_store_state = {}
feature_store_engine = None
feature_store_refresh_thread = None
feature_store_refresh_lock = threading.Lock()
feature_store_refresh_error = None
feature_store_refresh_last_result = None
FEATURE_REFRESH_CHECK_INTERVAL_MS = max(
    60000,
    int(os.getenv('NOMADIS_FEATURE_REFRESH_CHECK_INTERVAL_MS', '300000') or '300000')
)
FEATURE_REFRESH_STARTUP_DELAY_MS = max(
    0,
    int(os.getenv('NOMADIS_FEATURE_REFRESH_STARTUP_DELAY_MS', '5000') or '5000')
)
feature_refresh_scheduler_started = False
artifacts_load_metrics = {
    "total_ms": 0.0,
    "loaded_at": None
}
model_strategy = load_strategy(BASE_DIR)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace", line_buffering=True, write_through=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(errors="replace", line_buffering=True, write_through=True)


def load_local_env():
    env_path = BASE_DIR / '.env'
    if not env_path.exists():
        return

    if python_dotenv_load is not None:
        python_dotenv_load(dotenv_path=env_path, override=False)
        return

    for raw_line in env_path.read_text(encoding='utf8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip()


load_local_env()


def is_perf_debug_enabled():
    return str(os.getenv("COVERAGE_PERF_DEBUG", "")).strip().lower() in {"1", "true", "yes", "on"}


def emit_coverage_optimize_debug_logs(result):
    if not is_perf_debug_enabled():
        return

    print("[COVERAGE_DEBUG_PATH] optimize_endpoint_entered=true", flush=True)

    meta = result.get("meta") if isinstance(result, dict) and isinstance(result.get("meta"), dict) else {}
    debug_path = meta.get("debug_path") if isinstance(meta.get("debug_path"), dict) else {}
    solver_function = str(debug_path.get("solver_function") or "unknown")
    cp_sat_solve_reached = bool(debug_path.get("cp_sat_solve_reached"))
    print(f"[COVERAGE_DEBUG_PATH] solver_function={solver_function}", flush=True)
    print(f"[COVERAGE_DEBUG_PATH] cp_sat_solve_reached={'true' if cp_sat_solve_reached else 'false'}", flush=True)

    solver_selection = meta.get("solver_selection") if isinstance(meta.get("solver_selection"), dict) else None
    if isinstance(solver_selection, dict):
        print(
            "[COVERAGE_SOLVER_SELECTION] "
            f"selected_solver={str(solver_selection.get('selected_solver') or 'unknown')} "
            f"selection_reason={str(solver_selection.get('selection_reason') or 'unknown')} "
            f"clients_count={max(0, int(solver_selection.get('clients_count') or 0))} "
            f"slots_count={max(0, int(solver_selection.get('slots_count') or 0))} "
            f"candidate_pairs_count={max(0, int(solver_selection.get('candidate_pairs_count') or 0))} "
            f"thresholds={safe_json_dumps(solver_selection.get('thresholds') or {})}",
            flush=True
        )

    performance = meta.get("performance") if isinstance(meta.get("performance"), dict) else {}
    stages = performance.get("stages") if isinstance(performance.get("stages"), list) else []
    for stage in stages:
        if not isinstance(stage, dict) or not stage.get("stage"):
            continue
        print(
            f"[COVERAGE_PERF] stage={str(stage.get('stage') or 'unknown')} duration_ms={max(0, int(stage.get('duration_ms') or 0))}",
            flush=True
        )

    stage_names = {
        str(stage.get("stage") or "")
        for stage in stages
        if isinstance(stage, dict) and stage.get("stage")
    }
    if "python_solver_total" in stage_names and cp_sat_solve_reached and "python_solver_cp_sat_solve" not in stage_names:
        raise RuntimeError(
            "coverage perf debug inconsistency: python_solver_total exists but python_solver_cp_sat_solve is absent from the optimize endpoint response."
        )

    greedy = meta.get("greedy") if isinstance(meta.get("greedy"), dict) else None
    if isinstance(greedy, dict):
        print(
            "[COVERAGE_GREEDY] "
            f"clients_count={max(0, int(greedy.get('clients_count') or 0))} "
            f"slots_count={max(0, int(greedy.get('slots_count') or 0))} "
            f"candidate_pairs_count={max(0, int(greedy.get('candidate_pairs_count') or 0))} "
            f"assigned_clients_count={max(0, int(greedy.get('assigned_clients_count') or 0))} "
            f"unassigned_clients_count={max(0, int(greedy.get('unassigned_clients_count') or 0))} "
            f"mandatory_clients_count={max(0, int(greedy.get('mandatory_clients_count') or 0))} "
            f"assignment_attempts={max(0, int(greedy.get('assignment_attempts') or 0))} "
            f"candidate_evaluations={max(0, int(greedy.get('candidate_evaluations') or 0))} "
            f"capacity_checks={max(0, int(greedy.get('capacity_checks') or 0))} "
            f"rejected_by_capacity={max(0, int(greedy.get('rejected_by_capacity') or 0))} "
            f"rejected_by_constraint={max(0, int(greedy.get('rejected_by_constraint') or 0))} "
            f"rebalancing_iterations={max(0, int(greedy.get('rebalancing_iterations') or 0))} "
            f"repair_iterations={max(0, int(greedy.get('repair_iterations') or 0))} "
            f"distance_calls={max(0, int(greedy.get('distance_calls') or 0))} "
            f"distance_cache_hits={max(0, int(greedy.get('distance_cache_hits') or 0))} "
            f"distance_cache_misses={max(0, int(greedy.get('distance_cache_misses') or 0))} "
            f"full_candidate_scans={max(0, int(greedy.get('full_candidate_scans') or 0))} "
            f"repeated_sorts_count={max(0, int(greedy.get('repeated_sorts_count') or 0))} "
            f"sort_cache_hits={max(0, int(greedy.get('sort_cache_hits') or 0))} "
            f"score_cache_hits={max(0, int(greedy.get('score_cache_hits') or 0))} "
            f"score_cache_misses={max(0, int(greedy.get('score_cache_misses') or 0))}",
            flush=True
        )

    input_fingerprints = meta.get("input_fingerprints") if isinstance(meta.get("input_fingerprints"), dict) else None
    if isinstance(input_fingerprints, dict):
        print(
            "[COVERAGE_INPUT] "
            f"request_params_hash={str(input_fingerprints.get('request_params_hash') or '')} "
            f"clients_snapshot_hash={str(input_fingerprints.get('clients_snapshot_hash') or '')} "
            f"slots_hash={str(input_fingerprints.get('slots_hash') or '')} "
            f"constraints_hash={str(input_fingerprints.get('constraints_hash') or '')} "
            f"predictions_hash={str(input_fingerprints.get('predictions_hash') or '')} "
            f"history_profiles_hash={str(input_fingerprints.get('history_profiles_hash') or '')} "
            f"input_candidate_pairs_snapshot_hash={str(input_fingerprints.get('input_candidate_pairs_snapshot_hash') or '')} "
            f"functional_input_hash={str(input_fingerprints.get('functional_input_hash') or '')}",
            flush=True
        )

    greedy_trace = meta.get("greedy_trace") if isinstance(meta.get("greedy_trace"), dict) else None
    if isinstance(greedy_trace, dict):
        print(
            "[COVERAGE_GREEDY_TRACE] "
            f"greedy_candidate_order_hash={str(greedy_trace.get('greedy_candidate_order_hash') or '')} "
            f"client_priority_order_hash={str(greedy_trace.get('client_priority_order_hash') or '')} "
            f"candidate_order_by_client_hash={str(greedy_trace.get('candidate_order_by_client_hash') or '')} "
            f"initial_capacities_hash={str(greedy_trace.get('initial_capacities_hash') or '')} "
            f"assignment_decisions_hash={str(greedy_trace.get('assignment_decisions_hash') or '')} "
            f"assignments_before_postprocess_hash={str(greedy_trace.get('assignments_before_postprocess_hash') or '')} "
            f"assignments_after_postprocess_hash={str(greedy_trace.get('assignments_after_postprocess_hash') or '')} "
            f"canonical_functional_result_hash={str(greedy_trace.get('canonical_functional_result_hash') or '')}",
            flush=True
        )

    result_hashes = meta.get("result_hashes") if isinstance(meta.get("result_hashes"), dict) else None
    if isinstance(result_hashes, dict):
        print(
            "[COVERAGE_RESULT] "
            f"python_solver_result_hash={str(result_hashes.get('python_solver_result_hash') or '')} "
            f"python_response_before_flask_hash={str(result_hashes.get('python_response_before_flask_hash') or '')} "
            f"flask_json_response_hash={str(result_hashes.get('flask_json_response_hash') or '')} "
            f"canonical_functional_result_hash={str(result_hashes.get('canonical_functional_result_hash') or '')}",
            flush=True
        )

    cp_sat = meta.get("cp_sat") if isinstance(meta.get("cp_sat"), dict) else None
    if isinstance(cp_sat, dict):
        print(
            "[COVERAGE_CP_SAT] "
            f"clients_count={int(cp_sat.get('clients_count') or 0)} "
            f"slots_count={int(cp_sat.get('slots_count') or 0)} "
            f"candidate_pairs_count={int(cp_sat.get('candidate_pairs_count') or 0)} "
            f"bool_var_count={int(cp_sat.get('bool_var_count') or 0)} "
            f"int_var_count={int(cp_sat.get('int_var_count') or 0)} "
            f"constraints_count={int(cp_sat.get('constraints_count') or 0)} "
            f"objective_terms_count={int(cp_sat.get('objective_terms_count') or 0)} "
            f"model_proto_bytes={int(cp_sat.get('model_proto_bytes') or 0)} "
            f"status={str(cp_sat.get('status') or 'UNKNOWN')} "
            f"wall_time={float(cp_sat.get('wall_time') or 0.0)} "
            f"branches={int(cp_sat.get('branches') or 0)} "
            f"conflicts={int(cp_sat.get('conflicts') or 0)}",
            flush=True
        )
        constraints = cp_sat.get("constraints_by_category") if isinstance(cp_sat.get("constraints_by_category"), dict) else {}
        print(
            "[COVERAGE_CP_SAT_CONSTRAINTS] "
            + " ".join(
                f"{str(key)}={int(value or 0)}"
                for key, value in sorted(constraints.items(), key=lambda item: str(item[0]))
            ),
            flush=True
        )


_prediction_logging_tables_ready = False


def safe_json_dumps(value):
    try:
        return json.dumps(value, ensure_ascii=True, default=str)
    except Exception as error:
        return json.dumps({
            "error": "serialize_failed",
            "message": str(error)
        }, ensure_ascii=True)


def build_prediction_run_code(prefix='pred'):
    timestamp = datetime.utcnow().strftime('%Y%m%d%H%M%S')
    token = uuid.uuid4().hex[:12]
    return f"{prefix}-{timestamp}-{token}"


def read_precision_score():
    try:
        strategy_score = extract_precision_score(model_strategy)
        if strategy_score is not None:
            return strategy_score

        precision_text = (BASE_DIR / 'precision.txt').read_text(encoding='utf8').strip()
        if precision_text.startswith('{'):
            payload = json.loads(precision_text)
            json_score = extract_precision_score(payload)
            return json_score if json_score is not None else 0.0

        parsed = float(precision_text)
        return parsed if np.isfinite(parsed) else 0.0
    except Exception:
        return 0.0


def get_feature_store_engine():
    global feature_store_engine
    if feature_store_engine is None:
        feature_store_engine = create_engine(get_mysql_url(), pool_pre_ping=True)
    return feature_store_engine


def build_feature_store_features_version():
    source_watermark = feature_store_state.get('active_source_data_watermark')
    state_version = feature_store_state.get('active_feature_state_version')
    if not source_watermark or not state_version:
        return CANONICAL_FEATURE_SCHEMA_VERSION
    payload = {
        'feature_schema_version': CANONICAL_FEATURE_SCHEMA_VERSION,
        'source_data_watermark': source_watermark,
        'feature_state_version': state_version,
    }
    return f"sha1:{hashlib.sha1(safe_json_dumps(payload).encode('utf8')).hexdigest()[:16]}"


def build_feature_store_source_data_version():
    return feature_store_state.get('active_source_data_watermark') or 'missing'


def load_feature_store_runtime(engine=None):
    global df_master, df_daily_demand, df_prefs, prediction_history_source, feature_store_state, preferences_cache

    engine = engine or get_feature_store_engine()
    loaded_history, loaded_state = load_active_feature_store_frame(engine)
    feature_store_state = loaded_state or {}

    if loaded_history.empty:
        df_master = pd.DataFrame()
        df_daily_demand = pd.DataFrame()
        prediction_history_source = None
        df_prefs = pd.DataFrame(columns=['client_code', 'produit_nom', 'produit_code', 'qte_moyenne'])
        preferences_cache = {}
        return False

    df_master = loaded_history
    df_daily_demand = load_daily_demand_history(df_master, prefer_csv=False)
    prediction_history_source = 'canonical_feature_store'
    preferences_cache = {}

    cutoff_date = feature_store_state.get('active_source_max_date')
    if cutoff_date:
        df_prefs = build_preferences_frame(engine, cutoff_date)
        if 'client_code' in df_prefs.columns:
            df_prefs['client_code'] = df_prefs['client_code'].astype(str).str.strip()
        if 'produit_nom' in df_prefs.columns:
            df_prefs['produit_nom'] = df_prefs['produit_nom'].fillna(df_prefs.get('produit_code')).astype(str).str.strip()
        if 'qte_moyenne' in df_prefs.columns:
            df_prefs['qte_moyenne'] = pd.to_numeric(df_prefs['qte_moyenne'], errors='coerce').fillna(1)
    else:
        df_prefs = pd.DataFrame(columns=['client_code', 'produit_nom', 'produit_code', 'qte_moyenne'])
    return True


def get_preferences_frame_for_cutoff(cutoff_date, engine=None):
    global preferences_cache, df_prefs

    normalized_cutoff = str(cutoff_date or '').strip()
    if not normalized_cutoff:
        return df_prefs.copy() if not df_prefs.empty else pd.DataFrame(
            columns=['client_code', 'produit_nom', 'produit_code', 'qte_moyenne']
        )

    if normalized_cutoff in preferences_cache:
        return preferences_cache[normalized_cutoff].copy()

    engine = engine or get_feature_store_engine()
    prefs_frame = build_preferences_frame(engine, normalized_cutoff)
    if 'client_code' in prefs_frame.columns:
        prefs_frame['client_code'] = prefs_frame['client_code'].astype(str).str.strip()
    if 'produit_nom' in prefs_frame.columns:
        prefs_frame['produit_nom'] = prefs_frame['produit_nom'].fillna(prefs_frame.get('produit_code')).astype(str).str.strip()
    if 'qte_moyenne' in prefs_frame.columns:
        prefs_frame['qte_moyenne'] = pd.to_numeric(prefs_frame['qte_moyenne'], errors='coerce').fillna(1)

    preferences_cache[normalized_cutoff] = prefs_frame.copy()
    return prefs_frame.copy()


def _feature_store_refresh_worker(reason='background', force=False, target_date=None):
    global feature_store_refresh_error, feature_store_refresh_last_result

    engine = get_feature_store_engine()
    try:
        result = refresh_feature_store(engine, reason=reason, target_date=target_date)
        load_feature_store_runtime(engine)
        feature_store_refresh_error = None
        feature_store_refresh_last_result = result
        print(
            "Feature store refresh completed. "
            f"state_version={result.get('feature_state_version')} "
            f"source_max_date={result.get('source_max_date')} "
            f"rows={result.get('row_count')}"
        )
    except Exception as error:
        feature_store_refresh_error = str(error)
        feature_store_refresh_last_result = {
            'status': 'failed',
            'reason': reason,
            'error': str(error)
        }
        print(f"Feature store refresh failed: {error}")


def refresh_feature_store_singleflight(reason='background', force=False, wait=False, target_date=None):
    global feature_store_refresh_thread

    with feature_store_refresh_lock:
        active_thread = feature_store_refresh_thread
        if active_thread is not None and active_thread.is_alive():
            thread_to_join = active_thread
        else:
            thread_to_join = None
            if wait:
                feature_store_refresh_thread = None
            else:
                feature_store_refresh_thread = threading.Thread(
                    target=_feature_store_refresh_worker,
                    kwargs={'reason': reason, 'force': force, 'target_date': target_date},
                    daemon=True
                )
                feature_store_refresh_thread.start()
                thread_to_join = feature_store_refresh_thread

    if wait:
        if active_thread is not None and active_thread.is_alive():
            active_thread.join(timeout=FEATURE_STORE_BUILD_TIMEOUT_SECONDS)
            if active_thread.is_alive():
                return {
                    'status': 'building',
                    'reason': reason,
                    'active': True,
                    'started': False,
                    'reused': True
                }
            return feature_store_refresh_last_result or {'status': 'ready'}
        _feature_store_refresh_worker(reason=reason, force=force, target_date=target_date)
        return feature_store_refresh_last_result or {'status': 'ready'}

    return {
        'status': 'building',
        'reason': reason,
        'active': True,
        'started': thread_to_join is not None
    }


def schedule_feature_store_refresh_if_needed(reason='startup', force=False, target_date=None):
    engine = get_feature_store_engine()
    source_summary = build_feature_store_source_summary(engine, target_date=target_date)
    state = read_feature_store_state(engine)
    if feature_store_is_current(state, source_summary):
        return {
            'status': 'ready',
            'skipped': True,
            'reason': 'already_current',
            'state': state,
            'source_summary': source_summary
        }

    if feature_store_build_expired(state):
        print(
            "Feature store persisted building state exceeded timeout; "
            "recovering abandoned refresh."
        )
    return refresh_feature_store_singleflight(reason=reason, force=force, wait=False, target_date=target_date)


def ensure_feature_store_ready_for_target_date(target_date):
    global df_master, df_daily_demand, prediction_history_source

    engine = get_feature_store_engine()
    source_summary = build_feature_store_source_summary(engine, target_date=target_date)
    state = read_feature_store_state(engine)
    effective_cutoff = compute_effective_history_cutoff(target_date, state)
    current_source_max = pd.to_datetime(state.get('active_source_max_date'), errors='coerce')
    target_covered = feature_store_covers_target_date(state, target_date)

    snapshot_is_usable = (
        bool(state.get('active_feature_state_version')) and
        target_covered and
        not pd.isna(current_source_max) and
        effective_cutoff <=
        pd.Timestamp(current_source_max).normalize()
    )

    if snapshot_is_usable:
        if prediction_history_source != 'canonical_feature_store':
            load_feature_store_runtime(engine)

        if feature_store_is_current(state, source_summary):
            return {
                'status': 'ready',
                'effective_cutoff': (
                    effective_cutoff.date().isoformat()
                ),
                'state': state,
                'source_summary': source_summary
            }

        refresh_result = refresh_feature_store_singleflight(
            reason='prediction_request_stale_snapshot',
            force=False,
            wait=False,
            target_date=target_date
        )

        return {
            'status': 'ready_stale',
            'effective_cutoff': (
                effective_cutoff.date().isoformat()
            ),
            'state': state,
            'source_summary': source_summary,
            'refresh': refresh_result,
            'warning': (
                'canonical_feature_store_refresh_scheduled'
            )
        }

    refresh_feature_store_singleflight(reason='prediction_request', force=False, wait=True, target_date=target_date)

    refreshed_state = read_feature_store_state(engine)
    refreshed_source_summary = build_feature_store_source_summary(engine, target_date=target_date)
    refreshed_source_max = pd.to_datetime(refreshed_state.get('active_source_max_date'), errors='coerce')
    refreshed_cutoff = compute_effective_history_cutoff(target_date, refreshed_state)
    refreshed_target_covered = feature_store_covers_target_date(refreshed_state, target_date)
    if feature_store_is_current(refreshed_state, refreshed_source_summary) and refreshed_target_covered and not pd.isna(refreshed_source_max):
        load_feature_store_runtime(engine)
        return {
            'status': 'ready',
            'effective_cutoff': refreshed_cutoff.date().isoformat(),
            'state': refreshed_state,
            'source_summary': refreshed_source_summary
        }

    fallback_history = load_prediction_history()
    if not fallback_history.empty:
        df_master = fallback_history
        df_daily_demand = load_daily_demand_history(df_master)
        prediction_history_source = 'csv_fallback'
        return {
            'status': 'fallback',
            'effective_cutoff': refreshed_cutoff.date().isoformat(),
            'state': refreshed_state,
            'source_summary': refreshed_source_summary,
            'warning': 'canonical_feature_store_unavailable'
        }

    raise RuntimeError('Canonical feature store indisponible et aucun fallback CSV exploitable n est disponible.')


def start_feature_store_scheduler():
    global feature_refresh_scheduler_started
    if feature_refresh_scheduler_started:
        return
    feature_refresh_scheduler_started = True

    def _scheduler_loop():
        if FEATURE_REFRESH_STARTUP_DELAY_MS > 0:
            time.sleep(FEATURE_REFRESH_STARTUP_DELAY_MS / 1000.0)
        try:
            schedule_feature_store_refresh_if_needed(reason='startup')
        except Exception as error:
            print(f"Feature store startup refresh check failed: {error}")

        while True:
            time.sleep(FEATURE_REFRESH_CHECK_INTERVAL_MS / 1000.0)
            try:
                schedule_feature_store_refresh_if_needed(reason='interval')
            except Exception as error:
                print(f"Feature store interval refresh check failed: {error}")

    threading.Thread(target=_scheduler_loop, daemon=True).start()


def build_model_version():
    artifact_files = [
        'modele_nomadis_achat.pkl',
        'modele_nomadis_ca.pkl',
        'modele_nomadis_qte.pkl',
        'modele_nomadis_price.pkl',
        'modele_nomadis_affectation.pkl',
        'colonnes_ia.pkl',
        'colonnes_affectation.pkl',
        'classes_affectation.pkl',
        'precision.txt',
        'model_strategy.json',
    ]

    signature_parts = []
    for file_name in artifact_files:
        file_path = BASE_DIR / file_name
        if file_path.exists():
            stats = file_path.stat()
            signature_parts.append(f"{file_name}:{int(stats.st_mtime_ns)}:{stats.st_size}")
        else:
            signature_parts.append(f"{file_name}:missing")

    raw_signature = '|'.join(signature_parts)
    return f"sha1:{hashlib.sha1(raw_signature.encode('utf8')).hexdigest()[:16]}"


def build_features_version():
    return build_feature_store_features_version()


def get_mysql_connection():
    try:
        import pymysql
    except Exception as error:
        raise RuntimeError(f"pymysql indisponible pour logging IA: {error}") from error

    try:
        db_port = int(os.getenv('DB_PORT', '3306') or '3306')
    except ValueError:
        db_port = 3306

    return pymysql.connect(
        host=os.getenv('DB_HOST', 'localhost'),
        port=db_port,
        user=os.getenv('DB_USER', 'root'),
        password=os.getenv('DB_PASS', ''),
        database=os.getenv('DB_NAME', 'dist_utic'),
        charset='utf8mb4',
        autocommit=True
    )


def ensure_table_column(cursor, table_name, column_name, definition):
    cursor.execute(
        """
        SELECT 1
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = %s
          AND COLUMN_NAME = %s
        LIMIT 1
        """,
        (table_name, column_name)
    )
    if cursor.fetchone():
        return

    cursor.execute(f"ALTER TABLE `{table_name}` ADD COLUMN `{column_name}` {definition}")


def ensure_table_index(cursor, table_name, index_name, definition):
    cursor.execute(
        """
        SELECT 1
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = %s
          AND INDEX_NAME = %s
        LIMIT 1
        """,
        (table_name, index_name)
    )
    if cursor.fetchone():
        return

    cursor.execute(f"ALTER TABLE `{table_name}` ADD {definition}")


def resolve_active_client_ids_by_code(connection, client_codes):
    normalized_codes = [
        str(code).strip()
        for code in client_codes or []
        if str(code).strip()
    ]
    if not normalized_codes:
        return {}

    placeholders = ', '.join(['%s'] * len(normalized_codes))
    with connection.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT
                id,
                code
            FROM clients
            WHERE deleted_at IS NULL
              AND isactif = '1'
              AND code IN ({placeholders})
            """,
            normalized_codes
        )
        rows = cursor.fetchall()

    return {
        str(row[1]).strip(): int(row[0])
        for row in rows or []
        if row[0] is not None and str(row[1]).strip()
    }


def ensure_prediction_logging_tables(connection):
    global _prediction_logging_tables_ready
    if _prediction_logging_tables_ready:
        return

    with connection.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS ia_prediction_runs (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                run_code VARCHAR(191) NOT NULL,
                source_context VARCHAR(191) NOT NULL,
                source_mode VARCHAR(191) DEFAULT NULL,
                request_date DATE DEFAULT NULL,
                request_payload_json LONGTEXT DEFAULT NULL,
                request_context_json LONGTEXT DEFAULT NULL,
                request_commercials_json LONGTEXT DEFAULT NULL,
                request_route_code VARCHAR(191) DEFAULT NULL,
                request_commercial_code VARCHAR(191) DEFAULT NULL,
                request_top_clients INT DEFAULT NULL,
                request_target_chiffre DOUBLE DEFAULT NULL,
                response_status VARCHAR(64) DEFAULT NULL,
                response_message TEXT DEFAULT NULL,
                response_meta_json LONGTEXT DEFAULT NULL,
                total_candidates INT DEFAULT NULL,
                selected_clients INT DEFAULT NULL,
                expected_buyers_estimate INT DEFAULT NULL,
                selection_limit INT DEFAULT NULL,
                model_version VARCHAR(255) DEFAULT NULL,
                precision_score DOUBLE DEFAULT NULL,
                created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY ia_prediction_runs_code_unique (run_code),
                KEY ia_prediction_runs_context_idx (source_context),
                KEY ia_prediction_runs_request_date_idx (request_date),
                KEY ia_prediction_runs_commercial_idx (request_commercial_code)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS ia_prediction_items (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                run_code VARCHAR(191) NOT NULL,
                client_id BIGINT UNSIGNED DEFAULT NULL,
                client_code VARCHAR(191) NOT NULL,
                prediction_rank INT DEFAULT NULL,
                best_commercial_code VARCHAR(191) DEFAULT NULL,
                predicted_score DOUBLE DEFAULT NULL,
                confidence_score DOUBLE DEFAULT NULL,
                vip_score INT DEFAULT NULL,
                predicted_qte DOUBLE DEFAULT NULL,
                predicted_ca DOUBLE DEFAULT NULL,
                predicted_ca_if_buy DOUBLE DEFAULT NULL,
                predicted_qte_if_buy DOUBLE DEFAULT NULL,
                predicted_unit_price DOUBLE DEFAULT NULL,
                prob_achat DOUBLE DEFAULT NULL,
                habit_score DOUBLE DEFAULT NULL,
                recency_score DOUBLE DEFAULT NULL,
                details_json LONGTEXT DEFAULT NULL,
                commercial_scores_json LONGTEXT DEFAULT NULL,
                created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY ia_prediction_items_run_client_unique (run_code, client_code),
                KEY ia_prediction_items_run_code_idx (run_code),
                KEY ia_prediction_items_best_commercial_idx (best_commercial_code)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        """)

        ensure_table_column(cursor, 'ia_prediction_items', 'client_id', 'BIGINT UNSIGNED DEFAULT NULL')
        ensure_table_index(cursor, 'ia_prediction_items', 'ia_prediction_items_client_id_idx', 'INDEX `ia_prediction_items_client_id_idx` (`client_id`)')

    _prediction_logging_tables_ready = True


def log_prediction_snapshot(request_payload, response_payload):
    response_meta = response_payload.get('meta') if isinstance(response_payload.get('meta'), dict) else {}
    predictions = response_payload.get('predictions') if isinstance(response_payload.get('predictions'), dict) else {}
    commercials = request_payload.get('commercials', [])
    if isinstance(commercials, str):
        commercials = [item.strip() for item in commercials.split(',') if str(item).strip()]
    elif isinstance(commercials, list):
        commercials = [str(item).strip() for item in commercials if str(item).strip()]
    else:
        commercials = []

    raw_request_date = request_payload.get('date') or request_payload.get('start_date') or response_meta.get('date')
    request_date = str(raw_request_date)[:10] if raw_request_date else None
    run_code = build_prediction_run_code('pred')
    total_candidates = int(response_meta.get('total_candidates', len(predictions)))
    selected_clients = int(response_meta.get('selected_clients', len(predictions)))
    expected_buyers_estimate = response_meta.get('expected_buyers_estimate')
    selection_limit = response_meta.get('selection_limit')
    request_commercial_code = commercials[0] if len(commercials) == 1 else None

    connection = get_mysql_connection()
    try:
        ensure_prediction_logging_tables(connection)

        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO ia_prediction_runs (
                    run_code,
                    source_context,
                    source_mode,
                    request_date,
                    request_payload_json,
                    request_context_json,
                    request_commercials_json,
                    request_route_code,
                    request_commercial_code,
                    request_top_clients,
                    request_target_chiffre,
                    response_status,
                    response_message,
                    response_meta_json,
                    total_candidates,
                    selected_clients,
                    expected_buyers_estimate,
                    selection_limit,
                    model_version,
                    precision_score
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    run_code,
                    'api_predict',
                    None,
                    request_date,
                    safe_json_dumps(request_payload),
                    None,
                    safe_json_dumps(commercials),
                    None,
                    request_commercial_code,
                    None,
                    None,
                    response_payload.get('status'),
                    response_payload.get('message'),
                    safe_json_dumps(response_meta),
                    total_candidates,
                    selected_clients,
                    int(expected_buyers_estimate) if expected_buyers_estimate is not None else None,
                    int(selection_limit) if selection_limit is not None else None,
                    build_model_version(),
                    read_precision_score()
                )
            )

            if predictions:
                client_id_by_code = resolve_active_client_ids_by_code(connection, predictions.keys())
                item_rows = []
                for rank, (client_code, prediction) in enumerate(predictions.items(), start=1):
                    client_code_str = str(client_code).strip()
                    item_rows.append((
                        run_code,
                        client_id_by_code.get(client_code_str),
                        client_code_str,
                        rank,
                        str(prediction.get('best_commercial', '')).strip() or None,
                        float(prediction.get('score', 0) or 0),
                        float(prediction.get('confidence', 0) or 0),
                        int(prediction.get('vip', 0) or 0),
                        float(prediction.get('qte', 0) or 0),
                        float(prediction.get('chiffre', 0) or 0),
                        float(prediction.get('ca_if_buy', 0) or 0),
                        float(prediction.get('qte_if_buy', 0) or 0),
                        float(prediction.get('prix_moyen', 0) or 0),
                        float(prediction.get('prob_achat', 0) or 0),
                        float(prediction.get('habit_score', 0) or 0),
                        float(prediction.get('recency_score', 0) or 0),
                        safe_json_dumps(prediction.get('details', {})),
                        safe_json_dumps(prediction.get('commercial_scores', {}))
                    ))

                cursor.executemany(
                    """
                    INSERT INTO ia_prediction_items (
                        run_code,
                        client_id,
                        client_code,
                        prediction_rank,
                        best_commercial_code,
                        predicted_score,
                        confidence_score,
                        vip_score,
                        predicted_qte,
                        predicted_ca,
                        predicted_ca_if_buy,
                        predicted_qte_if_buy,
                        predicted_unit_price,
                        prob_achat,
                        habit_score,
                        recency_score,
                        details_json,
                        commercial_scores_json
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    item_rows
                )

        print(f"[AI_LOG] Snapshot enregistre -> run={run_code} items={len(predictions)}")
        return run_code
    finally:
        connection.close()


def finalize_prediction_response(request_payload, response_payload, status_code=200):
    payload = dict(response_payload or {})
    try:
        payload['prediction_run_code'] = log_prediction_snapshot(request_payload or {}, payload)
    except Exception as logging_error:
        print(f"[AI_LOG] Logging prediction impossible: {logging_error}")
        payload['prediction_run_code'] = None

    return jsonify(payload), status_code


def normalize_request_client_codes(raw_values):
    if isinstance(raw_values, str):
        values = [item.strip() for item in raw_values.split(',')]
    elif isinstance(raw_values, list):
        values = [str(item).strip() for item in raw_values]
    else:
        values = []

    seen = set()
    normalized = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    return normalized


def build_prediction_coverage_meta(*, requested_count, returned_count, known_count, null_count, selection_limit=None):
    safe_requested = max(0, int(requested_count or 0))
    safe_returned = max(0, int(returned_count or 0))
    safe_known = max(0, int(known_count or 0))
    safe_null = max(0, int(null_count or 0))
    safe_selection_limit = None if selection_limit is None else max(0, int(selection_limit or 0))

    return {
        "prediction_requested_clients_count": safe_requested,
        "prediction_returned_clients_count": safe_returned,
        "prediction_known_count": safe_known,
        "prediction_null_count": safe_null,
        "prediction_coverage_rate": round((safe_known / safe_requested), 4) if safe_requested > 0 else None,
        "top_k_truncation_detected": bool(
            safe_selection_limit is not None and safe_selection_limit > 0 and safe_selection_limit < safe_requested
        )
    }


def build_scored_prediction_candidates(data):
    if model_achat is None or model_ca is None or model_qte is None or model_price is None or not feature_columns or df_master.empty:
        raise RuntimeError(
            "Modeles IA ou historique complet non charges. "
            "Lancez train_auto.py pour regenerer les artefacts XGBoost."
        )

    feature_lookup_started_at = time.perf_counter()
    date_str = data.get('date', '2026-03-15')
    target_date = pd.to_datetime(date_str)
    min_prob_achat = float(data.get('min_prob_achat', 20))
    min_vn_predit = float(data.get('min_vn_predit', 12))
    min_ca_if_buy = float(data.get('min_ca_if_buy', 40))
    selection_multiplier = float(data.get('selection_multiplier', 1.1))
    min_clients_floor = int(data.get('min_clients_floor', 20))
    max_clients_cap = int(data.get('max_clients_cap', 250))
    max_clients_req = int(data.get('max_clients', 0))
    selected_commercials_raw = data.get('commercials', [])

    if isinstance(selected_commercials_raw, str):
        selected_commercials = [item.strip() for item in selected_commercials_raw.split(',') if str(item).strip()]
    elif isinstance(selected_commercials_raw, list):
        selected_commercials = [str(item).strip() for item in selected_commercials_raw if str(item).strip()]
    else:
        selected_commercials = []

    min_prob_achat = float(np.clip(min_prob_achat, 0, 100))
    min_vn_predit = max(0.0, min_vn_predit)
    min_ca_if_buy = max(0.0, min_ca_if_buy)
    selection_multiplier = float(np.clip(selection_multiplier, 1.0, 3.0))
    min_clients_floor = int(np.clip(min_clients_floor, 1, 300))
    max_clients_cap = int(np.clip(max_clients_cap, min_clients_floor, 2000))
    max_clients_req = max(0, max_clients_req)
    jour_semaine = (target_date.weekday() + 1) % 7
    day_of_month = int(target_date.day)
    week_of_month = int(((target_date.day - 1) // 7) + 1)
    days_to_month_end = int((target_date + pd.offsets.MonthEnd(0)).day - target_date.day)
    is_month_start = int(target_date.day <= 7)
    is_month_end = int(days_to_month_end <= 6)
    month = target_date.month

    print(f"Prediction demandee pour le jour : {jour_semaine} (Date: {date_str})")

    clients_du_jour, history_meta = select_prediction_candidates(target_date, jour_semaine)
    print(
        "Historique prediction retenu "
        f"(source={history_meta.get('history_source')}, cutoff={history_meta.get('history_cutoff_date')}, "
        f"candidats={history_meta.get('history_candidates_count', 0)})."
    )

    clients_du_jour['day_of_month'] = day_of_month
    clients_du_jour['week_of_month'] = week_of_month
    clients_du_jour['days_to_month_end'] = days_to_month_end
    clients_du_jour['is_month_start'] = is_month_start
    clients_du_jour['is_month_end'] = is_month_end
    clients_du_jour['month'] = month

    if clients_du_jour.empty:
        return {
            "date_str": date_str,
            "target_date": target_date,
            "clients_du_jour": clients_du_jour,
            "history_meta": history_meta,
            "filtered_clients": clients_du_jour,
            "selected_limit": 0,
            "selected_commercials": selected_commercials,
            "budget_meta": {
                "budget_reason": "no_candidates"
            },
            "timings": {
                "feature_lookup_ms": round((time.perf_counter() - feature_lookup_started_at) * 1000, 2),
                "prediction_compute_ms": 0.0
            }
        }

    feature_lookup_ms = round((time.perf_counter() - feature_lookup_started_at) * 1000, 2)
    prediction_compute_started_at = time.perf_counter()
    X_pred = build_features(clients_du_jour)
    historical_baselines = build_historical_baselines(clients_du_jour)
    achat_prob = np.clip(model_achat.predict_proba(X_pred)[:, 1], 0, 1)
    pred_ca_if_buy_model = np.maximum(0.0, np.expm1(model_ca.predict(X_pred)))
    pred_qte_if_buy_model = np.maximum(0.0, np.expm1(model_qte.predict(X_pred)))
    pred_price_if_buy_model = np.maximum(0.0, np.expm1(model_price.predict(X_pred)))

    ca_choice = resolve_target_choice(model_strategy, 'ca_if_buy')
    qte_choice = resolve_target_choice(model_strategy, 'qte_if_buy')
    price_choice = resolve_target_choice(model_strategy, 'price_if_buy')

    pred_ca_if_buy = (
        pred_ca_if_buy_model
        if ca_choice == 'model'
        else historical_baselines['ca_if_buy']
    )
    pred_qte_if_buy = (
        pred_qte_if_buy_model
        if qte_choice == 'model'
        else historical_baselines['qte_if_buy']
    )
    pred_price_if_buy = (
        pred_price_if_buy_model
        if price_choice == 'model'
        else historical_baselines['price_if_buy']
    )

    clients_du_jour['Prob_modele'] = np.round(achat_prob * 100, 1)
    clients_du_jour['Pred_ca_if_buy'] = pred_ca_if_buy
    clients_du_jour['Pred_qte_if_buy'] = pred_qte_if_buy
    clients_du_jour['Prix_pred'] = pred_price_if_buy
    clients_du_jour['Pred_ca_if_buy_model'] = pred_ca_if_buy_model
    clients_du_jour['Pred_qte_if_buy_model'] = pred_qte_if_buy_model
    clients_du_jour['Prix_pred_model'] = pred_price_if_buy_model
    clients_du_jour['Pred_ca_if_buy_baseline'] = historical_baselines['ca_if_buy']
    clients_du_jour['Pred_qte_if_buy_baseline'] = historical_baselines['qte_if_buy']
    clients_du_jour['Prix_pred_baseline'] = historical_baselines['price_if_buy']
    clients_du_jour['Habit_score'] = clients_du_jour.apply(compute_habit_score, axis=1)
    clients_du_jour['Recency_score'] = clients_du_jour.apply(compute_recency_score, axis=1)
    clients_du_jour['Prob_hist'] = clients_du_jour.apply(build_purchase_probability, axis=1)
    clients_du_jour['Prob_achat'] = clients_du_jour.apply(
        lambda row: stabilize_purchase_probability(
            row['Prob_modele'],
            row['Prob_hist'],
            row['Habit_score'],
            row['Recency_score'],
            row['Pred_ca_if_buy']
        ),
        axis=1
    )
    fallback_mask = ~np.isfinite(clients_du_jour['Prob_achat'])
    if fallback_mask.any():
        clients_du_jour.loc[fallback_mask, 'Prob_achat'] = clients_du_jour.loc[fallback_mask, 'Prob_hist']

    clients_du_jour['Vn_predit'] = clients_du_jour['Pred_ca_if_buy'] * (clients_du_jour['Prob_achat'] / 100.0)
    clients_du_jour['Qte_predite'] = clients_du_jour.apply(
        lambda row: blend_expected_quantity(
            row['Prob_achat'] / 100.0,
            row['Pred_ca_if_buy'],
            row['Pred_qte_if_buy'],
            row['Prix_pred'],
            row.get('avg_price_hist', np.nan)
        ),
        axis=1
    )
    budget_meta = estimate_daily_budget(target_date)
    clients_du_jour, budget_meta = apply_daily_budget_controls(clients_du_jour, budget_meta)

    max_vn = clients_du_jour['Vn_predit'].max()

    def build_confidence(row):
        visites = int(row.get('nbr_visites_hist', 0)) if pd.notna(row.get('nbr_visites_hist')) else 0
        base = 35
        if visites >= 2:
            base = 45
        if visites >= 4:
            base = 55
        if visites >= 8:
            base = 65
        if visites >= 16:
            base = 75
        if visites >= 32:
            base = 82
        if visites >= 64:
            base = 88
        if visites >= 128:
            base = 92
        bonus = min(8, int((row['Vn_predit'] / max_vn) * 8)) if max_vn > 0 else 0
        return round(min(100, base + bonus), 1)

    clients_du_jour['Confidence'] = clients_du_jour.apply(build_confidence, axis=1)
    clients_du_jour['Cadence_score'] = clients_du_jour.apply(compute_cadence_score, axis=1)
    clients_du_jour['Basket_fit_score'] = clients_du_jour.apply(compute_basket_fit_score, axis=1)
    clients_du_jour['Score'] = clients_du_jour.apply(
        lambda row: compute_priority_score(row, max_vn),
        axis=1
    )
    clients_du_jour['VIP'] = clients_du_jour.apply(
        lambda row: int(round(clamp((0.65 * float(row['Score'])) + (0.35 * ((float(row['Vn_predit']) / max(max_vn, 1.0)) * 100.0)), 0.0, 100.0))),
        axis=1
    )

    base_filter = (
        (
            (clients_du_jour['Prob_achat'] >= min_prob_achat) |
            (clients_du_jour['Score'] >= max(28.0, min_prob_achat * 1.15))
        ) &
        (
            (clients_du_jour['Vn_predit'] >= min_vn_predit) |
            (clients_du_jour['Pred_ca_if_buy'] >= min_ca_if_buy)
        )
    )
    filtered_clients = clients_du_jour[base_filter].copy()

    if filtered_clients.empty:
        filtered_clients = clients_du_jour.copy()

    expected_buyers = int(np.ceil((clients_du_jour['Prob_achat'].clip(0, 100) / 100.0).sum()))
    budget_expected_buyers = int(np.ceil(float(budget_meta.get('expected_buyers_estimate', 0) or 0)))
    if budget_expected_buyers > 0:
        expected_buyers = min(expected_buyers, max(1, int(np.ceil(budget_expected_buyers * 1.15))))
    dynamic_limit = int(np.clip(np.ceil(expected_buyers * selection_multiplier), min_clients_floor, max_clients_cap))
    selected_limit = max_clients_req if max_clients_req > 0 else dynamic_limit
    selected_limit = int(np.clip(selected_limit, 1, max_clients_cap))

    filtered_clients = filtered_clients.sort_values(
        ['Score', 'Prob_achat', 'Prob_modele', 'Vn_predit', 'Cadence_score', 'Basket_fit_score', 'Habit_score', 'Recency_score'],
        ascending=False
    )
    prediction_compute_ms = round((time.perf_counter() - prediction_compute_started_at) * 1000, 2)

    return {
        "date_str": date_str,
        "target_date": target_date,
        "clients_du_jour": clients_du_jour,
        "history_meta": history_meta,
        "filtered_clients": filtered_clients,
        "selected_limit": selected_limit,
        "selected_commercials": selected_commercials,
        "budget_meta": budget_meta,
        "strategy_meta": {
            "ca_if_buy": ca_choice,
            "qte_if_buy": qte_choice,
            "price_if_buy": price_choice,
        },
        "timings": {
            "feature_lookup_ms": feature_lookup_ms,
            "prediction_compute_ms": prediction_compute_ms
        }
    }


def build_dashboard_prediction_output(filtered_clients, selected_limit, selected_commercials, preferences_frame=None):
    filtered_head = filtered_clients.head(selected_limit).copy()
    commercial_scores_by_client = {}
    effective_prefs = preferences_frame if preferences_frame is not None else df_prefs

    if model_affectation is not None and assignment_feature_columns and assignment_classes and not filtered_head.empty:
        X_assignment = build_assignment_features(filtered_head)
        assignment_probabilities = np.clip(model_affectation.predict_proba(X_assignment), 0, 1)

        for row_index, (_, row) in enumerate(filtered_head.iterrows()):
            code_str = str(row['client_code']).strip()

            score_map = {
                assignment_classes[class_index]: round(float(assignment_probabilities[row_index][class_index]) * 100, 1)
                for class_index in range(min(len(assignment_classes), assignment_probabilities.shape[1]))
            }

            if selected_commercials:
                home_code = str(row.get('home_commercial', '')).strip()
                filtered_score_map = {}
                for commercial_code in selected_commercials:
                    if commercial_code in score_map:
                        filtered_score_map[commercial_code] = score_map[commercial_code]
                    else:
                        filtered_score_map[commercial_code] = 75.0 if commercial_code == home_code else 0.0
                score_map = filtered_score_map

            commercial_scores_by_client[code_str] = dict(
                sorted(score_map.items(), key=lambda item: item[1], reverse=True)
            )

    allocated_quantities_by_client, _ = allocate_dashboard_client_quantities(filtered_head)

    result_dict = {}
    for _, row in filtered_head.iterrows():
        code_str = str(row['client_code']).strip()
        allocated_quantity = int(allocated_quantities_by_client.get(code_str, 0) or 0)
        if allocated_quantity <= 0:
            continue

        if 'client_code' in effective_prefs.columns and not effective_prefs.empty:
            df_prefs_filtered = effective_prefs[effective_prefs['client_code'] == code_str]
        else:
            df_prefs_filtered = pd.DataFrame()

        product_weights = {}
        if not df_prefs_filtered.empty:
            for _, p_row in df_prefs_filtered.iterrows():
                produit = str(p_row.get('produit_nom', '')).strip()
                if not produit or produit == 'nan':
                    produit = str(p_row.get('produit_code', 'Produit')).strip()
                if not produit or produit == 'Produit' or produit == 'nan':
                    produit = 'Standard'
                product_weights[produit] = float(p_row.get('qte_moyenne', 1) or 1)

        product_weights = {
            produit: qte
            for produit, qte in product_weights.items()
            if pd.notna(qte) and float(qte) > 0
        }
        if not product_weights:
            continue

        details_qte, total_qte = rebalance_quantities(allocated_quantity, product_weights)
        if total_qte <= 0:
            continue
        prix_moyen = float(row['Vn_predit']) / float(total_qte)
        commercial_scores = commercial_scores_by_client.get(code_str, {})
        best_commercial = next(iter(commercial_scores), str(row.get('home_commercial', '')).strip())

        result_dict[code_str] = {
            "score": round(row['Score'], 1),
            "confidence": round(row['Confidence'], 1),
            "vip": int(row['VIP']),
            "qte": int(total_qte),
            "chiffre": round(float(row['Vn_predit']), 2),
            "ca_if_buy": round(float(row['Pred_ca_if_buy']), 2),
            "qte_if_buy": round(float(row['Pred_qte_if_buy']), 2),
            "details": details_qte,
            "prix_moyen": round(prix_moyen, 2),
            "prob_achat": round(float(row['Prob_achat']), 1),
            "prob_modele": round(float(row['Prob_modele']), 1),
            "habit_score": round(float(row['Habit_score']), 1),
            "recency_score": round(float(row['Recency_score']), 1),
            "cadence_score": round(float(row['Cadence_score']), 1),
            "basket_fit_score": round(float(row['Basket_fit_score']), 1),
            "commercial_scores": commercial_scores,
            "best_commercial": best_commercial
        }

    return {
        "filtered_head": filtered_head,
        "predictions": result_dict
    }


def build_batch_prediction_rows(scored_clients, requested_client_codes):
    requested_codes = normalize_request_client_codes(requested_client_codes)
    if not requested_codes:
        return []

    if scored_clients is None or scored_clients.empty:
        scored_by_code = {}
    else:
        scored_by_code = {
            str(row['client_code']).strip(): row
            for _, row in scored_clients.iterrows()
        }

    client_id_by_code = {}
    try:
        connection = get_mysql_connection()
        client_id_by_code = resolve_active_client_ids_by_code(connection, requested_codes)
        connection.close()
    except Exception as error:
        print(f"[AI_BATCH] Resolution client_id impossible: {error}")

    rows = []
    for client_code in requested_codes:
        row = scored_by_code.get(client_code)
        if row is None:
            rows.append({
                "client_id": client_id_by_code.get(client_code),
                "client_code": client_code,
                "purchase_probability": None,
                "predicted_ca": None,
                "recommended_quantity": None,
                "model_confidence": None,
                "score": None,
                "vip": None,
                "prediction_source": "not_scored_for_requested_date",
                "predicted_ca_if_buy": None,
                "predicted_quantity_if_buy": None,
                "probability_model_only": None,
                "habit_score": None,
                "recency_score": None
            })
            continue

        rows.append({
            "client_id": client_id_by_code.get(client_code),
            "client_code": client_code,
            "purchase_probability": round(float(row['Prob_achat']), 1) if pd.notna(row['Prob_achat']) else None,
            "predicted_ca": round(float(row['Vn_predit']), 2) if pd.notna(row['Vn_predit']) else None,
            "recommended_quantity": round(float(row['Qte_predite']), 2) if pd.notna(row['Qte_predite']) else None,
            "model_confidence": round(float(row['Confidence']), 1) if pd.notna(row['Confidence']) else None,
            "score": round(float(row['Score']), 1) if pd.notna(row['Score']) else None,
            "vip": int(row['VIP']) if pd.notna(row['VIP']) else None,
            "prediction_source": "xgboost_date_specific_batch",
            "predicted_ca_if_buy": round(float(row['Pred_ca_if_buy']), 2) if pd.notna(row['Pred_ca_if_buy']) else None,
            "predicted_quantity_if_buy": round(float(row['Pred_qte_if_buy']), 2) if pd.notna(row['Pred_qte_if_buy']) else None,
            "probability_model_only": round(float(row['Prob_modele']), 1) if pd.notna(row['Prob_modele']) else None,
            "habit_score": round(float(row['Habit_score']), 1) if pd.notna(row['Habit_score']) else None,
            "recency_score": round(float(row['Recency_score']), 1) if pd.notna(row['Recency_score']) else None
        })

    return rows


def build_features(df):
    features = df[FEATURE_COLUMNS_BASE + MAIN_CATEGORICAL_COLUMNS].copy()
    for col in MAIN_CATEGORICAL_COLUMNS:
        features[col] = features[col].fillna('Inconnu').astype(str).str.strip()
    for col in FEATURE_COLUMNS_BASE:
        features[col] = pd.to_numeric(features[col], errors='coerce').fillna(0)
    features = pd.get_dummies(features, columns=MAIN_CATEGORICAL_COLUMNS, dummy_na=False)
    if feature_columns:
        features = features.reindex(columns=feature_columns, fill_value=0)
    return features


def build_assignment_features(df):
    features = df[FEATURE_COLUMNS_BASE + ASSIGNMENT_CATEGORICAL_COLUMNS].copy()
    for col in FEATURE_COLUMNS_BASE:
        features[col] = pd.to_numeric(features[col], errors='coerce').fillna(0)
    for col in ASSIGNMENT_CATEGORICAL_COLUMNS:
        features[col] = features[col].fillna('Inconnu').astype(str).str.strip()
    features = pd.get_dummies(features, columns=ASSIGNMENT_CATEGORICAL_COLUMNS, dummy_na=False)
    if assignment_feature_columns:
        features = features.reindex(columns=assignment_feature_columns, fill_value=0)
    return features


def rebalance_quantities(target_total, details_qte):
    target_total = int(round(float(target_total)))
    if target_total <= 0:
        return {}, 0
    if not details_qte:
        return {}, 0

    total_hist = sum(max(0, float(qte)) for qte in details_qte.values())
    if total_hist <= 0:
        return {}, 0

    weighted = []
    for produit, qte in details_qte.items():
        poids = max(0, float(qte)) / total_hist
        exact = target_total * poids
        base = int(np.floor(exact))
        weighted.append({
            'nom': produit,
            'base': base,
            'remainder': exact - base
        })

    current_total = sum(item['base'] for item in weighted)
    diff = target_total - current_total

    if diff > 0:
        weighted.sort(key=lambda item: item['remainder'], reverse=True)
        for index in range(diff):
            weighted[index % len(weighted)]['base'] += 1
    elif diff < 0:
        weighted.sort(key=lambda item: item['remainder'])
        for item in weighted:
            while diff < 0 and item['base'] > 0:
                item['base'] -= 1
                diff += 1
            if diff == 0:
                break

    final_details = {item['nom']: int(item['base']) for item in weighted if item['base'] > 0}
    final_total = sum(final_details.values())
    if final_total <= 0:
        return {}, 0
    return final_details, final_total


def build_dashboard_client_canonical_tie_break(row):
    raw_client_id = row.get('client_id')
    if pd.notna(raw_client_id):
        client_id_str = str(raw_client_id).strip()
        if client_id_str:
            if client_id_str.isdigit():
                return (0, int(client_id_str), client_id_str)
            return (1, client_id_str)

    client_code_str = str(row.get('client_code', '')).strip()
    return (2, client_code_str)


def build_dashboard_client_priority_key(row):
    def sanitize(value):
        numeric = float(value) if pd.notna(value) else 0.0
        return numeric if np.isfinite(numeric) else 0.0

    return (
        -sanitize(row.get('Score', 0.0)),
        -sanitize(row.get('Prob_achat', 0.0)),
        -sanitize(row.get('Prob_modele', 0.0)),
        -sanitize(row.get('Vn_predit', 0.0)),
        -sanitize(row.get('Cadence_score', 0.0)),
        -sanitize(row.get('Basket_fit_score', 0.0)),
        -sanitize(row.get('Habit_score', 0.0)),
        -sanitize(row.get('Recency_score', 0.0)),
    )


def allocate_dashboard_client_quantities(filtered_head):
    if filtered_head is None or filtered_head.empty:
        return {}, 0

    weighted_clients = []
    total_fractional_quantity = 0.0

    for priority_rank, (_, row) in enumerate(filtered_head.iterrows()):
        client_code = str(row.get('client_code', '')).strip()
        if not client_code:
            continue

        raw_quantity = row.get('Qte_predite', 0.0)
        quantity = float(raw_quantity) if pd.notna(raw_quantity) else 0.0
        quantity = max(0.0, quantity)
        base_quantity = int(np.floor(quantity))

        weighted_clients.append({
            'client_code': client_code,
            'base_quantity': base_quantity,
            'remainder': quantity - base_quantity,
            'priority_rank': priority_rank,
            'priority_key': build_dashboard_client_priority_key(row),
            'canonical_tie_break': build_dashboard_client_canonical_tie_break(row),
        })
        total_fractional_quantity += quantity

    rounded_total_quantity = int(round(total_fractional_quantity))
    if rounded_total_quantity <= 0 or not weighted_clients:
        return {}, 0

    allocated_total_quantity = sum(item['base_quantity'] for item in weighted_clients)
    diff = rounded_total_quantity - allocated_total_quantity

    if diff > 0:
        weighted_clients.sort(
            key=lambda item: (
                -item['remainder'],
                item['priority_key'],
                item['canonical_tie_break'],
                item['priority_rank'],
            )
        )
        for item in weighted_clients[:diff]:
            item['base_quantity'] += 1
    elif diff < 0:
        weighted_clients.sort(
            key=lambda item: (
                item['remainder'],
                tuple(-value for value in item['priority_key']),
                item['canonical_tie_break'],
                -item['priority_rank'],
            )
        )
        for item in weighted_clients:
            if diff == 0:
                break
            removable_units = min(item['base_quantity'], abs(diff))
            item['base_quantity'] -= removable_units
            diff += removable_units

    allocations = {
        item['client_code']: int(item['base_quantity'])
        for item in weighted_clients
        if int(item['base_quantity']) > 0
    }
    return allocations, sum(allocations.values())


def blend_expected_quantity(prob_buy, ca_if_buy, qte_if_buy, price_if_buy, avg_price_hist):
    prob_buy = max(0.0, min(1.0, float(prob_buy)))
    ca_if_buy = max(0.0, float(ca_if_buy))
    qte_if_buy = max(0.0, float(qte_if_buy))
    price_if_buy = max(0.0, float(price_if_buy))
    avg_price_hist = float(avg_price_hist) if pd.notna(avg_price_hist) else np.nan

    expected_ca = ca_if_buy * prob_buy
    qte_from_model = qte_if_buy * prob_buy
    qte_from_price = expected_ca / max(0.5, price_if_buy)

    hist_price = avg_price_hist if np.isfinite(avg_price_hist) and avg_price_hist > 0.5 else price_if_buy
    qte_from_hist = expected_ca / max(0.5, hist_price)
    return max(0.0, (0.50 * qte_from_price) + (0.35 * qte_from_model) + (0.15 * qte_from_hist))


def build_purchase_probability(row):
    weekday_rate = max(0.0, min(1.0, float(row.get('weekday_purchase_rate', 0) or 0)))
    visites_hist = max(1.0, float(row.get('nbr_visites_hist', 0) or 0))
    visites_jour = max(0.0, float(row.get('nbr_visites_jour', 0) or 0))
    recency_days = max(0, float(row.get('days_since_last_order', 999)))

    weekday_support = min(1.0, visites_jour / visites_hist)
    recency_factor = max(0.0, 1.0 - min(recency_days, 45.0) / 45.0)

    prob = (0.60 * weekday_rate) + (0.25 * weekday_support) + (0.15 * recency_factor)
    return round(prob * 100, 1)


def stabilize_purchase_probability(model_prob_pct, hist_prob_pct, habit_score, recency_score, ca_if_buy):
    model_prob_pct = float(model_prob_pct) if pd.notna(model_prob_pct) else 0.0
    hist_prob_pct = float(hist_prob_pct) if pd.notna(hist_prob_pct) else 0.0
    habit_score = float(habit_score) if pd.notna(habit_score) else 0.0
    recency_score = float(recency_score) if pd.notna(recency_score) else 0.0
    ca_if_buy = float(ca_if_buy) if pd.notna(ca_if_buy) else 0.0

    blended = (
        (0.88 * model_prob_pct) +
        (0.07 * hist_prob_pct) +
        (0.03 * habit_score) +
        (0.02 * recency_score)
    )

    if model_prob_pct >= 6 and hist_prob_pct >= 18 and ca_if_buy >= 80:
        blended += 2.0
    elif model_prob_pct >= 3 and hist_prob_pct >= 12 and ca_if_buy >= 30:
        blended += 1.0

    max_allowed = max(2.0, model_prob_pct * 2.0)
    blended = min(blended, max_allowed)
    return round(float(np.clip(blended, 0, 85)), 1)


def compute_habit_score(row):
    weekday_rate = max(0.0, float(row.get('weekday_purchase_rate', 0) or 0))
    recent_ca_trend = max(0.0, float(row.get('recent_ca_trend', 0) or 0))
    recent_qte_trend = max(0.0, float(row.get('recent_qte_trend', 0) or 0))

    weekday_score = min(1.0, weekday_rate)
    trend_score = min(1.2, (recent_ca_trend + recent_qte_trend) / 2.0) / 1.2
    return round(((0.7 * weekday_score) + (0.3 * trend_score)) * 100, 1)


def compute_recency_score(row):
    days_last_order = max(0.0, float(row.get('days_since_last_order', 999) or 999))
    days_last_same_weekday = max(0.0, float(row.get('days_since_last_same_weekday_order', 999) or 999))

    recency_general = max(0.0, 1.0 - min(days_last_order, 60.0) / 60.0)
    recency_weekday = max(0.0, 1.0 - min(days_last_same_weekday, 90.0) / 90.0)
    return round(((0.6 * recency_general) + (0.4 * recency_weekday)) * 100, 1)


def clamp(value, min_value, max_value):
    return min(max_value, max(min_value, value))


def compute_cadence_score(row):
    gap_ratio = float(row.get('order_gap_ratio', np.nan))
    days_since_last_order = float(row.get('days_since_last_order', np.nan))
    avg_gap = float(row.get('avg_days_between_orders_5', np.nan))

    if not np.isfinite(gap_ratio) or gap_ratio <= 0 or not np.isfinite(avg_gap) or avg_gap <= 0:
        return 40.0

    score = 100.0 - (abs(np.log(max(gap_ratio, 0.05))) * 60.0)
    if gap_ratio < 0.45:
        score *= 0.55
    elif gap_ratio > 2.5:
        score *= 0.85

    if np.isfinite(days_since_last_order) and days_since_last_order < 2:
        score = min(score, 30.0)

    return round(clamp(score, 10.0, 100.0), 1)


def compute_basket_fit_score(row):
    pred_ca_if_buy = max(1.0, float(row.get('Pred_ca_if_buy', 0) or 0))
    hist_avg_order = float(row.get('avg_ca_per_order_90d', np.nan))
    orders_90d = float(row.get('orders_last_90d', 0) or 0)

    if not np.isfinite(hist_avg_order) or hist_avg_order <= 1 or orders_90d < 3:
        return 55.0

    ratio = pred_ca_if_buy / max(1.0, hist_avg_order)
    score = 100.0 - (abs(np.log(max(ratio, 0.05))) * 55.0)
    return round(clamp(score, 20.0, 100.0), 1)


def compute_priority_score(row, max_vn):
    value_norm = np.sqrt(clamp(float(row.get('Vn_predit', 0) or 0) / max(max_vn, 1.0), 0.0, 1.0))
    final_prob = clamp(float(row.get('Prob_achat', 0) or 0) / 100.0, 0.0, 1.0)
    model_prob = clamp(float(row.get('Prob_modele', 0) or 0) / 100.0, 0.0, 1.0)
    habit = clamp(float(row.get('Habit_score', 0) or 0) / 100.0, 0.0, 1.0)
    recency = clamp(float(row.get('Recency_score', 0) or 0) / 100.0, 0.0, 1.0)
    cadence = compute_cadence_score(row) / 100.0
    basket_fit = compute_basket_fit_score(row) / 100.0

    buy_signal = (
        (0.45 * final_prob) +
        (0.20 * model_prob) +
        (0.15 * habit) +
        (0.10 * recency) +
        (0.10 * cadence)
    )
    score_norm = (
        (0.50 * buy_signal) +
        (0.25 * value_norm) +
        (0.15 * basket_fit) +
        (0.10 * cadence)
    )
    return round(clamp(score_norm * 100.0, 0.0, 100.0), 1)


def load_prediction_history():
    history_path = BASE_DIR / 'dataset_features_clients_jour.csv'
    if not history_path.exists():
        raise RuntimeError(
            "Historique complet introuvable: dataset_features_clients_jour.csv. "
            "Lancez train_auto.py pour regenerer les artefacts IA."
        )

    history = pd.read_csv(history_path, low_memory=False, dtype=CLIENT_CODE_CSV_DTYPE)
    if 'date_doc' not in history.columns:
        raise RuntimeError("dataset_features_clients_jour.csv ne contient pas la colonne date_doc.")

    history['history_date'] = pd.to_datetime(history['date_doc'], errors='coerce').dt.normalize()
    history = history.dropna(subset=['history_date']).copy()
    history['client_code'] = history['client_code'].astype(str).str.strip()
    history['region'] = history['region'].fillna('Inconnu').astype(str).str.strip()
    history['delegation'] = history['delegation'].fillna('Inconnue').astype(str).str.strip() if 'delegation' in history.columns else 'Inconnue'
    history['routing_code'] = history['routing_code'].fillna('Inconnue').astype(str).str.strip() if 'routing_code' in history.columns else 'Inconnue'
    history['home_commercial'] = history['home_commercial'].fillna('Inconnu').astype(str).str.strip() if 'home_commercial' in history.columns else 'Inconnu'
    if 'potentiel' in history.columns:
        history['potentiel'] = pd.to_numeric(history['potentiel'], errors='coerce').fillna(0)
    else:
        history['potentiel'] = 0

    for col in FEATURE_COLUMNS_BASE:
        if col == 'jour_semaine' and col not in history.columns:
            history[col] = ((history['history_date'].dt.weekday + 1) % 7).astype(int)
        elif col in history.columns:
            history[col] = pd.to_numeric(history[col], errors='coerce').fillna(0)
        else:
            history[col] = 0

    history['jour_semaine'] = pd.to_numeric(history['jour_semaine'], errors='coerce').fillna(0).astype(int)
    history = history.sort_values(['history_date', 'client_code', 'jour_semaine']).reset_index(drop=True)
    return history


def build_daily_demand_history(history):
    if history.empty:
        return pd.DataFrame(columns=['date_doc', 'jour_semaine', 'total_ca', 'total_qte', 'buyers', 'active_clients'])

    working = history.copy()
    source_date_col = 'date_doc' if 'date_doc' in working.columns else 'history_date'
    working['date_doc'] = pd.to_datetime(working[source_date_col], errors='coerce').dt.normalize()
    working = working.dropna(subset=['date_doc']).copy()
    working['client_code'] = working['client_code'].astype(str).str.strip()
    if 'ca_jour' in working.columns:
        ca_source = working['ca_jour']
    elif 'vente_nette' in working.columns:
        ca_source = working['vente_nette']
    else:
        ca_source = pd.Series(0, index=working.index, dtype='float64')

    if 'qte_jour' in working.columns:
        qte_source = working['qte_jour']
    elif 'qte_totale' in working.columns:
        qte_source = working['qte_totale']
    else:
        qte_source = pd.Series(0, index=working.index, dtype='float64')

    working['ca_jour'] = pd.to_numeric(ca_source, errors='coerce').fillna(0)
    working['qte_jour'] = pd.to_numeric(qte_source, errors='coerce').fillna(0)
    if 'achat_target' in working.columns:
        working['achat_target'] = pd.to_numeric(working['achat_target'], errors='coerce').fillna(0).astype(int)
    else:
        working['achat_target'] = (working['ca_jour'] > 0).astype(int)

    daily = (
        working.groupby('date_doc', as_index=False)
        .agg(
            total_ca=('ca_jour', 'sum'),
            total_qte=('qte_jour', 'sum'),
            buyers=('achat_target', 'sum'),
            active_clients=('client_code', 'nunique')
        )
    )
    daily['jour_semaine'] = ((daily['date_doc'].dt.weekday + 1) % 7).astype(int)
    for col in ['total_ca', 'total_qte', 'buyers', 'active_clients']:
        daily[col] = pd.to_numeric(daily[col], errors='coerce').fillna(0)
    return daily.sort_values('date_doc').reset_index(drop=True)


def load_daily_demand_history(history, prefer_csv=True):
    history_path = BASE_DIR / 'daily_demand_history.csv'
    if prefer_csv and history_path.exists():
        daily = pd.read_csv(history_path, low_memory=False)
        if 'date_doc' not in daily.columns:
            raise RuntimeError("daily_demand_history.csv ne contient pas la colonne date_doc.")
        daily['date_doc'] = pd.to_datetime(daily['date_doc'], errors='coerce').dt.normalize()
        daily = daily.dropna(subset=['date_doc']).copy()
        if 'jour_semaine' not in daily.columns:
            daily['jour_semaine'] = ((daily['date_doc'].dt.weekday + 1) % 7).astype(int)
        for col in ['total_ca', 'total_qte', 'buyers', 'active_clients']:
            if col not in daily.columns:
                daily[col] = 0
            daily[col] = pd.to_numeric(daily[col], errors='coerce').fillna(0)
        daily['jour_semaine'] = pd.to_numeric(daily['jour_semaine'], errors='coerce').fillna(0).astype(int)
        return daily.sort_values('date_doc').reset_index(drop=True)
    return build_daily_demand_history(history)


def estimate_daily_budget(target_date):
    budget_meta = {
        'budget_reason': 'daily_history_not_loaded',
        'budget_target_date': pd.Timestamp(target_date).normalize().date().isoformat()
    }

    if df_daily_demand.empty:
        return budget_meta

    target_ts = pd.Timestamp(target_date).normalize()
    current_day_cap = pd.Timestamp(datetime.now().date())
    available_max_date = pd.Timestamp(df_daily_demand['date_doc'].max()).normalize()
    trusted_max_date = min(current_day_cap, available_max_date)

    history = df_daily_demand[
        (df_daily_demand['date_doc'] < target_ts) &
        (df_daily_demand['date_doc'] <= trusted_max_date)
    ].copy()

    budget_meta.update({
        'budget_current_day_cap': current_day_cap.date().isoformat(),
        'budget_available_max_date': available_max_date.date().isoformat(),
        'budget_trusted_max_date': trusted_max_date.date().isoformat(),
        'budget_history_rows': int(len(history))
    })

    if history.empty:
        budget_meta['budget_reason'] = 'no_daily_history_before_target'
        return budget_meta

    jour_semaine = int((target_ts.weekday() + 1) % 7)
    same_weekday = history[history['jour_semaine'] == jour_semaine].tail(12).copy()
    recent_all = history.tail(56).copy()
    weekday_reference = same_weekday if not same_weekday.empty else recent_all

    def robust_anchor(series):
        values = pd.to_numeric(series, errors='coerce').dropna()
        if values.empty:
            return 0.0
        return float((0.65 * values.median()) + (0.35 * values.quantile(0.75)))

    buyers_anchor = (0.75 * robust_anchor(weekday_reference['buyers'])) + (0.25 * robust_anchor(recent_all['buyers']))
    ca_anchor = (0.75 * robust_anchor(weekday_reference['total_ca'])) + (0.25 * robust_anchor(recent_all['total_ca']))
    qte_anchor = (0.75 * robust_anchor(weekday_reference['total_qte'])) + (0.25 * robust_anchor(recent_all['total_qte']))

    budget_meta.update({
        'budget_reason': 'ok',
        'budget_same_weekday_rows': int(len(same_weekday)),
        'budget_recent_rows': int(len(recent_all)),
        'expected_buyers_estimate': max(1.0, round(float(buyers_anchor), 1)),
        'expected_total_ca': max(0.0, round(float(ca_anchor), 2)),
        'expected_total_qte': max(0.0, round(float(qte_anchor), 2))
    })
    return budget_meta


def apply_daily_budget_controls(predictions, budget_meta):
    if predictions.empty:
        budget_meta['probability_scale'] = 1.0
        budget_meta['volume_scale'] = 1.0
        return predictions, budget_meta

    adjusted = predictions.copy()
    raw_expected_buyers = float(adjusted['Prob_achat'].clip(0, 100).sum() / 100.0)
    prob_scale = 1.0

    expected_buyers = float(budget_meta.get('expected_buyers_estimate', 0) or 0)
    if expected_buyers > 0:
        buyer_cap = max(1.0, expected_buyers * 1.15)
        if raw_expected_buyers > buyer_cap:
            prob_scale = buyer_cap / max(raw_expected_buyers, 1e-9)
            adjusted['Prob_achat'] = np.round(np.clip(adjusted['Prob_achat'] * prob_scale, 0, 85), 1)

    adjusted['Vn_predit'] = adjusted['Pred_ca_if_buy'] * (adjusted['Prob_achat'] / 100.0)
    adjusted['Qte_predite'] = adjusted.apply(
        lambda row: blend_expected_quantity(
            row['Prob_achat'] / 100.0,
            row['Pred_ca_if_buy'],
            row['Pred_qte_if_buy'],
            row['Prix_pred'],
            row.get('avg_price_hist', np.nan)
        ),
        axis=1
    )

    raw_total_ca = float(adjusted['Vn_predit'].sum())
    raw_total_qte = float(adjusted['Qte_predite'].sum())
    expected_total_ca = float(budget_meta.get('expected_total_ca', 0) or 0)
    expected_total_qte = float(budget_meta.get('expected_total_qte', 0) or 0)

    ca_scale = (expected_total_ca * 1.10 / raw_total_ca) if expected_total_ca > 0 and raw_total_ca > (expected_total_ca * 1.10) else 1.0
    qte_scale = (expected_total_qte * 1.10 / raw_total_qte) if expected_total_qte > 0 and raw_total_qte > (expected_total_qte * 1.10) else 1.0
    volume_scale = min(1.0, ca_scale, qte_scale)

    if volume_scale < 1.0:
        adjusted['Vn_predit'] = adjusted['Vn_predit'] * volume_scale
        adjusted['Qte_predite'] = adjusted['Qte_predite'] * volume_scale

    budget_meta.update({
        'probability_scale': round(float(prob_scale), 4),
        'volume_scale': round(float(volume_scale), 4),
        'raw_expected_buyers': round(raw_expected_buyers, 2),
        'scaled_expected_buyers': round(float(adjusted['Prob_achat'].clip(0, 100).sum() / 100.0), 2),
        'raw_total_ca_pred': round(raw_total_ca, 2),
        'scaled_total_ca_pred': round(float(adjusted['Vn_predit'].sum()), 2),
        'raw_total_qte_pred': round(raw_total_qte, 2),
        'scaled_total_qte_pred': round(float(adjusted['Qte_predite'].sum()), 2)
    })
    return adjusted, budget_meta


def select_prediction_candidates(target_date, jour_semaine):
    history_meta = {
        "history_source": prediction_history_source or 'canonical_feature_store',
        "history_target_date": pd.Timestamp(target_date).normalize().date().isoformat()
    }

    feature_store_meta = ensure_feature_store_ready_for_target_date(target_date)
    history_meta.update({
        "feature_schema_version": CANONICAL_FEATURE_SCHEMA_VERSION,
        "source_data_watermark": build_feature_store_source_data_version()
    })
    if feature_store_meta.get('warning'):
        history_meta['history_warning'] = feature_store_meta['warning']

    if df_master.empty:
        history_meta["history_reason"] = "history_not_loaded"
        return pd.DataFrame(), history_meta

    target_ts = pd.Timestamp(target_date).normalize()
    prediction_cutoff = target_ts - pd.Timedelta(days=1)
    history_date_column = 'history_date' if 'history_date' in df_master.columns else 'date'
    available_max_date = pd.Timestamp(df_master[history_date_column].max()).normalize()
    trusted_max_date = min(
        pd.Timestamp(feature_store_meta.get('effective_cutoff') or prediction_cutoff).normalize(),
        available_max_date
    )
    history_cutoff = trusted_max_date
    history_meta.update({
        "history_prediction_cutoff_date": prediction_cutoff.date().isoformat(),
        "history_available_max_date": available_max_date.date().isoformat(),
        "history_trusted_max_date": trusted_max_date.date().isoformat(),
        "history_cutoff_date": history_cutoff.date().isoformat(),
    })

    if prediction_history_source == 'canonical_feature_store':
        eligible_history = df_master[
            (pd.to_datetime(df_master['date'], errors='coerce').dt.normalize() == target_ts) &
            (pd.to_numeric(df_master['jour_semaine'], errors='coerce').fillna(-1).astype(int) == int(jour_semaine))
        ].copy()
        history_meta["history_rows_scanned"] = int(len(eligible_history))

        if eligible_history.empty:
            history_meta["history_reason"] = "no_feature_state_for_target_date"
            return eligible_history, history_meta

        candidates = eligible_history.sort_values(['client_code']).copy()
        history_meta.update({
            "history_reason": "ok",
            "history_candidate_min_date": target_ts.date().isoformat(),
            "history_candidate_max_date": target_ts.date().isoformat(),
            "history_candidates_count": int(len(candidates))
        })
        return candidates, history_meta

    eligible_history = df_master[
        (df_master['jour_semaine'] == int(jour_semaine)) &
        (df_master[history_date_column] <= history_cutoff)
    ].copy()
    history_meta["history_rows_scanned"] = int(len(eligible_history))

    if eligible_history.empty:
        history_meta["history_reason"] = "no_history_before_cutoff"
        return eligible_history, history_meta

    candidates = (
        eligible_history
        .sort_values(['client_code', history_date_column])
        .groupby('client_code', as_index=False)
        .tail(1)
        .copy()
    )

    history_meta.update({
        "history_reason": "ok",
        "history_candidate_min_date": pd.Timestamp(candidates[history_date_column].min()).date().isoformat(),
        "history_candidate_max_date": pd.Timestamp(candidates[history_date_column].max()).date().isoformat(),
        "history_candidates_count": int(len(candidates))
    })
    return candidates, history_meta


def load_artifacts():
    global model_achat, model_ca, model_qte, model_price
    global model_affectation, feature_columns, assignment_feature_columns, assignment_classes
    global df_master, prediction_history_source, df_daily_demand, df_prefs, feature_store_state
    global artifacts_load_metrics
    global model_strategy

    print("Chargement des modeles XGBoost et des donnees...")
    started_at = time.perf_counter()
    try:
        engine = get_feature_store_engine()
        ensure_feature_store_tables(engine)
        model_achat = joblib.load('modele_nomadis_achat.pkl')
        model_ca = joblib.load('modele_nomadis_ca.pkl')
        model_qte = joblib.load('modele_nomadis_qte.pkl')
        model_price = joblib.load('modele_nomadis_price.pkl')
        feature_columns = joblib.load('colonnes_ia.pkl')
        model_strategy = load_strategy(BASE_DIR)
        store_state = read_feature_store_state(engine)
        source_summary = build_feature_store_source_summary(engine)
        loaded_from_store = False
        if feature_store_is_current(store_state, source_summary):
            loaded_from_store = load_feature_store_runtime(engine)
        elif store_state.get('active_feature_state_version'):
            loaded_from_store = load_feature_store_runtime(engine)
            schedule_feature_store_refresh_if_needed(reason='startup')
        else:
            refresh_feature_store_singleflight(reason='startup_bootstrap', wait=True)
            loaded_from_store = load_feature_store_runtime(engine)

        if not loaded_from_store:
            df_master = load_prediction_history()
            prediction_history_source = 'csv_fallback'
            df_daily_demand = load_daily_demand_history(df_master)
            df_prefs = pd.read_csv('preferences_clients_produits.csv', dtype=CLIENT_CODE_CSV_DTYPE)
            if 'client_code' in df_prefs.columns:
                df_prefs['client_code'] = df_prefs['client_code'].astype(str).str.strip()
            if 'qte_moyenne' in df_prefs.columns:
                df_prefs['qte_moyenne'] = pd.to_numeric(df_prefs['qte_moyenne'], errors='coerce').fillna(1)
            feature_store_state = read_feature_store_state(engine)

        try:
            model_affectation = joblib.load('modele_nomadis_affectation.pkl')
            assignment_feature_columns = joblib.load('colonnes_affectation.pkl')
            assignment_classes = joblib.load('classes_affectation.pkl')
            assignment_classes = [str(code).strip() for code in assignment_classes]
        except Exception as assign_error:
            model_affectation = None
            assignment_feature_columns = []
            assignment_classes = []
            print(f"Modele d'affectation non charge : {assign_error}")

        history_min = df_master['history_date'].min().date().isoformat() if not df_master.empty else 'n/a'
        history_max = df_master['history_date'].max().date().isoformat() if not df_master.empty else 'n/a'
        daily_rows = len(df_daily_demand)
        print(
            "IA prete avec les modeles XGBoost Achat + CA + Quantite. "
            f"Historique de prediction: {prediction_history_source} ({history_min} -> {history_max}). "
            f"Historique journalier: {daily_rows} jours."
        )
        start_feature_store_scheduler()
        artifacts_load_metrics = {
            "total_ms": round((time.perf_counter() - started_at) * 1000, 2),
            "loaded_at": datetime.utcnow().isoformat() + 'Z'
        }
        return True, "Modeles IA recharges avec succes."
    except Exception as e:
        print(f"Erreur de chargement : {e}")
        return False, str(e)


load_artifacts()


def build_model_status_payload():
    return {
        "ready": bool(
            model_achat is not None and
            model_ca is not None and
            model_qte is not None and
            model_price is not None and
            feature_columns and
            not df_master.empty
        ),
        "model_version": build_model_version(),
        "features_version": build_features_version(),
        "prediction_history_source": prediction_history_source,
        "regression_strategy": {
            "ca_if_buy": resolve_target_choice(model_strategy, "ca_if_buy"),
            "qte_if_buy": resolve_target_choice(model_strategy, "qte_if_buy"),
            "price_if_buy": resolve_target_choice(model_strategy, "price_if_buy"),
        },
        "feature_schema_version": CANONICAL_FEATURE_SCHEMA_VERSION,
        "source_data_watermark": build_feature_store_source_data_version(),
        "feature_store_state": feature_store_state,
        "history_rows": int(len(df_master)),
        "daily_history_rows": int(len(df_daily_demand)),
        "artifacts_load_metrics": artifacts_load_metrics
    }


@app.route('/api/reload-models', methods=['POST'])
def reload_models():
    success, message = load_artifacts()
    return jsonify({
        "status": "success" if success else "error",
        "message": message,
        **build_model_status_payload()
    }), (200 if success else 500)


@app.route('/api/model-status', methods=['GET'])
def model_status():
    return jsonify({
        "status": "success",
        **build_model_status_payload()
    }), 200


@app.route('/api/predict', methods=['POST'])
def predict_tournee():
    data = request.json or {}
    try:
        scoring_result = build_scored_prediction_candidates(data)
        date_str = scoring_result['date_str']
        clients_du_jour = scoring_result['clients_du_jour']
        history_meta = scoring_result['history_meta']
        filtered_clients = scoring_result['filtered_clients']
        selected_limit = scoring_result['selected_limit']
        selected_commercials = scoring_result['selected_commercials']
        budget_meta = scoring_result['budget_meta']

        if clients_du_jour.empty:
            cutoff_date = history_meta.get('history_cutoff_date', date_str)
            return finalize_prediction_response(data, {
                "status": "error",
                "message": f"Pas d'historique exploitable avant le {cutoff_date} pour ce jour."
            })

        preferences_frame = get_preferences_frame_for_cutoff(
            history_meta.get('history_cutoff_date'),
            engine=feature_store_engine,
        )
        dashboard_output = build_dashboard_prediction_output(
            filtered_clients,
            selected_limit,
            selected_commercials,
            preferences_frame=preferences_frame
        )
        filtered_head = dashboard_output['filtered_head']
        result_dict = dashboard_output['predictions']
        expected_buyers = int(np.ceil((clients_du_jour['Prob_achat'].clip(0, 100) / 100.0).sum()))
        coverage_meta = build_prediction_coverage_meta(
            requested_count=len(clients_du_jour),
            returned_count=len(result_dict),
            known_count=len(result_dict),
            null_count=max(0, len(clients_du_jour) - len(result_dict)),
            selection_limit=selected_limit
        )

        return finalize_prediction_response(data, {
            "status": "success",
            "predictions": result_dict,
            "meta": {
                "date": date_str,
                "total_candidates": int(len(clients_du_jour)),
                "selected_clients": int(len(filtered_head)),
                "expected_buyers_estimate": int(expected_buyers),
                "selection_limit": int(selected_limit),
                "history_source": history_meta.get('history_source'),
                "history_cutoff_date": history_meta.get('history_cutoff_date'),
                "history_target_date": history_meta.get('history_target_date'),
                "history_current_day_cap": history_meta.get('history_current_day_cap'),
                "history_available_max_date": history_meta.get('history_available_max_date'),
                "history_trusted_max_date": history_meta.get('history_trusted_max_date'),
                "history_rows_scanned": int(history_meta.get('history_rows_scanned', 0)),
                "history_candidate_min_date": history_meta.get('history_candidate_min_date'),
                "history_candidate_max_date": history_meta.get('history_candidate_max_date'),
                "budget_reason": budget_meta.get('budget_reason'),
                "budget_history_rows": int(budget_meta.get('budget_history_rows', 0)),
                "budget_same_weekday_rows": int(budget_meta.get('budget_same_weekday_rows', 0)),
                "budget_recent_rows": int(budget_meta.get('budget_recent_rows', 0)),
                "budget_current_day_cap": budget_meta.get('budget_current_day_cap'),
                "budget_available_max_date": budget_meta.get('budget_available_max_date'),
                "budget_trusted_max_date": budget_meta.get('budget_trusted_max_date'),
                "expected_total_ca": float(budget_meta.get('expected_total_ca', 0) or 0),
                "expected_total_qte": float(budget_meta.get('expected_total_qte', 0) or 0),
                "probability_scale": float(budget_meta.get('probability_scale', 1.0) or 1.0),
                "volume_scale": float(budget_meta.get('volume_scale', 1.0) or 1.0),
                "raw_expected_buyers": float(budget_meta.get('raw_expected_buyers', 0) or 0),
                "scaled_expected_buyers": float(budget_meta.get('scaled_expected_buyers', 0) or 0),
                "raw_total_ca_pred": float(budget_meta.get('raw_total_ca_pred', 0) or 0),
                "scaled_total_ca_pred": float(budget_meta.get('scaled_total_ca_pred', 0) or 0),
                "raw_total_qte_pred": float(budget_meta.get('raw_total_qte_pred', 0) or 0),
                "scaled_total_qte_pred": float(budget_meta.get('scaled_total_qte_pred', 0) or 0),
                "prediction_date_specific": True,
                **coverage_meta
            }
        })

    except Exception as e:
        status_code = 503 if "non charges" in str(e) else 500
        return finalize_prediction_response(data, {"status": "error", "message": str(e)}, status_code)


@app.route('/api/predict-client-batch', methods=['POST'])
def predict_client_batch():
    data = request.json or {}
    batch_started_at = time.perf_counter()
    try:
        requested_client_codes = normalize_request_client_codes(
            data.get('client_codes', data.get('client_ids', []))
        )
        scoring_result = build_scored_prediction_candidates(data)
        date_str = scoring_result['date_str']
        clients_du_jour = scoring_result['clients_du_jour']
        filtered_clients = scoring_result['filtered_clients']
        history_meta = scoring_result['history_meta']

        batch_rows = build_batch_prediction_rows(clients_du_jour, requested_client_codes)
        known_count = sum(1 for row in batch_rows if row.get('purchase_probability') is not None)
        null_count = len(batch_rows) - known_count
        coverage_meta = build_prediction_coverage_meta(
            requested_count=len(requested_client_codes),
            returned_count=len(batch_rows),
            known_count=known_count,
            null_count=null_count,
            selection_limit=None
        )
        scoring_timings = scoring_result.get('timings') or {}
        serialization_started_at = time.perf_counter()
        response_payload = {
            "status": "success",
            "predictions": batch_rows,
            "meta": {
                "date": date_str,
                "requested_client_codes_count": len(requested_client_codes),
                "requested_count": len(requested_client_codes),
                "known_count": int(known_count),
                "null_count": int(null_count),
                "unique_dates_count": 1 if date_str else 0,
                "total_candidates": int(len(clients_du_jour)),
                "filtered_candidates": int(len(filtered_clients)),
                "history_cutoff_date": history_meta.get('history_cutoff_date'),
                "history_target_date": history_meta.get('history_target_date'),
                "prediction_date_specific": True,
                "batch_exact_response": True,
                "model_version": build_model_version(),
                "features_version": build_features_version(),
                "model_load_ms": 0.0,
                "feature_lookup_ms": float(scoring_timings.get('feature_lookup_ms', 0.0) or 0.0),
                "prediction_compute_ms": float(scoring_timings.get('prediction_compute_ms', 0.0) or 0.0),
                "artifacts_total_load_ms": float((artifacts_load_metrics or {}).get('total_ms', 0.0) or 0.0),
                "artifacts_loaded_at": (artifacts_load_metrics or {}).get('loaded_at'),
                **coverage_meta
            }
        }
        response_payload["meta"]["serialization_ms"] = round((time.perf_counter() - serialization_started_at) * 1000, 2)
        response_payload["meta"]["batch_total_ms"] = round((time.perf_counter() - batch_started_at) * 1000, 2)

        return jsonify(response_payload), 200
    except Exception as error:
        status_code = 503 if "non charges" in str(error) else 500
        return jsonify({
            "status": "error",
            "message": str(error)
        }), status_code


def _safe_int(value, default=0):
    try:
        parsed = int(float(value))
        return parsed
    except Exception:
        return default


def _safe_float(value, default=0.0):
    try:
        parsed = float(value)
        return parsed if np.isfinite(parsed) else default
    except Exception:
        return default


def _safe_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return value != 0

    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _haversine_km(lat1, lon1, lat2, lon2):
    try:
        lat1 = float(lat1)
        lon1 = float(lon1)
        lat2 = float(lat2)
        lon2 = float(lon2)
    except Exception:
        return None

    radius = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2 +
        math.cos(math.radians(lat1)) *
        math.cos(math.radians(lat2)) *
        math.sin(d_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return radius * c


def _normalize_slot_entry(slot, default_requested_max=30, default_hard_max=60):
    slot_id = str(slot.get('id') or '').strip()
    if not slot_id:
        return None

    requested_max = max(1, _safe_int(slot.get('requested_max_clients'), default_requested_max))
    explicit_hard_max = max(
        0,
        _safe_int(slot.get('hard_max_clients'), 0),
        _safe_int(slot.get('max_clients'), 0)
    )
    hard_max = explicit_hard_max if explicit_hard_max > 0 else max(requested_max, default_hard_max)

    return {
        "id": slot_id,
        "date": str(slot.get('date') or '').strip(),
        "day_label": str(slot.get('day_label') or '').strip(),
        "commercial_code": str(slot.get('commercial_code') or slot.get('proposed_commercial') or '').strip(),
        "commercial_label": str(slot.get('commercial_label') or slot.get('proposed_commercial_label') or '').strip(),
        "requested_max_clients": requested_max,
        "hard_max_clients": hard_max,
        "truck_capacity_units": max(0, int(math.ceil(_safe_float(slot.get('max_truck_units'), 0.0)))),
        "load_units_per_client": max(1, int(math.ceil(_safe_float(slot.get('load_units_per_client'), 1.0)))),
        "latitude": _safe_float(slot.get('latitude'), None),
        "longitude": _safe_float(slot.get('longitude'), None)
    }


def _normalize_client_entry(client):
    client_key = str(
        client.get('canonical_client_key') or
        client.get('client_code') or
        client.get('nbr_client') or
        ''
    ).strip()
    if not client_key:
        return None

    candidate_slots = []
    for raw_candidate in (client.get('candidate_slots') or []):
        slot_id = str(raw_candidate.get('slot_id') or '').strip()
        if not slot_id:
            continue
        candidate_slots.append({
            "slot_id": slot_id,
            "assignment_prob": _safe_float(raw_candidate.get('assignment_prob'), 0.0),
            "predicted_ca": _safe_float(raw_candidate.get('predicted_ca'), _safe_float(client.get('predicted_ca'), 0.0)),
            "utility_score": _safe_float(raw_candidate.get('utility_score'), 0.0)
        })

    return {
        "client_key": client_key,
        "client_code": str(client.get('client_code') or client.get('nbr_client') or client_key).strip(),
        "nom": str(client.get('nom') or '').strip(),
        "latitude": _safe_float(client.get('latitude'), None),
        "longitude": _safe_float(client.get('longitude'), None),
        "predicted_ca": max(0.0, _safe_float(client.get('predicted_ca'), 0.0)),
        "distance_km": max(0.0, _safe_float(client.get('distance_km'), 0.0)),
        "is_critical_coverage": bool(client.get('is_critical_coverage')),
        "days_since_last_visit": max(0, _safe_int(client.get('days_since_last_visit'), 0)),
        "service_minutes_per_client": max(0.0, _safe_float(client.get('service_minutes_per_client'), 0.0)),
        "planned_load_units_per_client": max(1, _safe_int(
            client.get('planned_load_units_per_client') or
            client.get('ia_qte_reco') or
            client.get('qte_reco'),
            1
        )),
        "historical_load_units_per_client": max(1, _safe_int(client.get('historical_load_units_per_client'), 1)),
        "preferred_commercial": str(client.get('preferred_commercial') or client.get('recommended_commercial') or '').strip(),
        "candidate_slots": sorted(
            candidate_slots,
            key=lambda item: (
                item["utility_score"],
                item["predicted_ca"],
                item["assignment_prob"]
            ),
            reverse=True
        )
    }


def _nearest_neighbor_client_keys(clients, depot_origin=None):
    if not clients:
        return []

    depot_lat = _safe_float((depot_origin or {}).get('latitude'), None)
    depot_lon = _safe_float((depot_origin or {}).get('longitude'), None)
    current_lat = depot_lat
    current_lon = depot_lon
    remaining = clients[:]
    ordered = []

    while remaining:
        if current_lat is None or current_lon is None:
            remaining.sort(
                key=lambda item: (
                    0 if item.get('latitude') is not None and item.get('longitude') is not None else 1,
                    -float(item.get('is_critical_coverage') or 0),
                    -_safe_float(item.get('predicted_ca'), 0.0),
                    -_safe_float(item.get('utility_score'), 0.0)
                )
            )
            next_client = remaining.pop(0)
        else:
            scored = []
            for item in remaining:
                if item.get('latitude') is None or item.get('longitude') is None:
                    distance = float('inf')
                else:
                    distance = _haversine_km(current_lat, current_lon, item.get('latitude'), item.get('longitude'))
                    if distance is None:
                        distance = float('inf')
                scored.append((distance, item))

            scored.sort(key=lambda pair: (pair[0], -_safe_float(pair[1].get('predicted_ca'), 0.0)))
            next_client = scored[0][1]
            remaining.remove(next_client)

        ordered.append(next_client["client_key"])
        current_lat = next_client.get('latitude', current_lat)
        current_lon = next_client.get('longitude', current_lon)

    return ordered


def _estimate_anchor_distance_km(client, slot=None, depot_origin=None):
    client_lat = _safe_float(client.get('latitude'), None)
    client_lon = _safe_float(client.get('longitude'), None)
    anchor_lat = _safe_float((slot or {}).get('latitude'), None)
    anchor_lon = _safe_float((slot or {}).get('longitude'), None)

    if anchor_lat is None or anchor_lon is None:
        anchor_lat = _safe_float((depot_origin or {}).get('latitude'), None)
        anchor_lon = _safe_float((depot_origin or {}).get('longitude'), None)

    if (
        client_lat is not None and
        client_lon is not None and
        anchor_lat is not None and
        anchor_lon is not None
    ):
        distance_km = _haversine_km(anchor_lat, anchor_lon, client_lat, client_lon)
        if distance_km is not None:
            return max(0.0, float(distance_km))

    return max(0.0, _safe_float(client.get('distance_km'), 0.0))


def _estimate_candidate_minutes(
    client,
    slot=None,
    depot_origin=None,
    default_service_minutes=12.0,
    average_drive_speed_kmh=30.0,
    travel_share_factor=0.55,
    stop_handling_minutes=5.0
):
    service_minutes = max(0.0, _safe_float(client.get('service_minutes_per_client'), default_service_minutes))
    anchor_distance_km = _estimate_anchor_distance_km(client, slot=slot, depot_origin=depot_origin)
    drive_speed_kmh = max(12.0, _safe_float(average_drive_speed_kmh, 30.0))
    shared_drive_factor = min(1.0, max(0.25, _safe_float(travel_share_factor, 0.55)))
    drive_minutes = (anchor_distance_km / drive_speed_kmh) * 60.0 if anchor_distance_km > 0 else 0.0
    estimated_minutes = service_minutes + max(0.0, _safe_float(stop_handling_minutes, 5.0)) + (drive_minutes * shared_drive_factor)
    return max(1, int(math.ceil(estimated_minutes)))


def _estimate_ordered_route_minutes(
    ordered_clients,
    depot_origin=None,
    default_service_minutes=12.0,
    average_drive_speed_kmh=30.0,
    stop_handling_minutes=5.0
):
    if not ordered_clients:
        return 0.0

    drive_speed_kmh = max(12.0, _safe_float(average_drive_speed_kmh, 30.0))
    current_lat = _safe_float((depot_origin or {}).get('latitude'), None)
    current_lon = _safe_float((depot_origin or {}).get('longitude'), None)
    total_minutes = 0.0

    for client in ordered_clients:
        client_lat = _safe_float(client.get('latitude'), None)
        client_lon = _safe_float(client.get('longitude'), None)

        if (
            current_lat is not None and
            current_lon is not None and
            client_lat is not None and
            client_lon is not None
        ):
            leg_km = _haversine_km(current_lat, current_lon, client_lat, client_lon)
            total_minutes += max(0.0, _safe_float(leg_km, 0.0)) / drive_speed_kmh * 60.0
        elif current_lat is None and current_lon is None:
            total_minutes += max(0.0, _safe_float(client.get('distance_km'), 0.0)) / drive_speed_kmh * 60.0

        service_minutes = max(0.0, _safe_float(client.get('service_minutes_per_client'), default_service_minutes))
        total_minutes += max(0.0, _safe_float(stop_handling_minutes, 5.0)) + service_minutes

        if client_lat is not None and client_lon is not None:
            current_lat = client_lat
            current_lon = client_lon

    return round(total_minutes, 2)


def _sum_top_candidate_metric(candidates, field_name, limit):
    safe_limit = max(0, int(limit or 0))
    if safe_limit <= 0 or not candidates:
        return 0

    values = sorted(
        [max(0, int(round(_safe_float(candidate.get(field_name), 0.0)))) for candidate in candidates],
        reverse=True
    )
    return sum(values[:safe_limit])


def _count_candidates_within_duration(candidates, max_route_minutes):
    duration_limit = max(0, int(round(_safe_float(max_route_minutes, 0.0))))
    if duration_limit <= 0:
        return len(candidates)

    total_minutes = 0
    count = 0
    for minutes in sorted(max(1, int(round(_safe_float(candidate.get("estimated_minutes"), 0.0)))) for candidate in candidates):
        if total_minutes + minutes > duration_limit:
            break
        total_minutes += minutes
        count += 1
    return count


def _sum_shortest_candidate_minutes(candidates, limit):
    safe_limit = max(0, int(limit or 0))
    if safe_limit <= 0 or not candidates:
        return 0

    values = sorted(max(1, int(round(_safe_float(candidate.get("estimated_minutes"), 0.0)))) for candidate in candidates)
    return sum(values[:safe_limit])


def _build_coverage_infeasibility_diagnostics(
    slots,
    clients,
    client_candidate_map,
    min_visits,
    max_visits,
    min_total_ca=0.0,
    max_route_minutes=0.0
):
    active_client_indexes = sorted(client_candidate_map.keys())
    total_clients = len(active_client_indexes)
    total_slots = len(slots)
    minimum_required_blocks = int(math.ceil(total_clients / max(1, max_visits))) if total_clients > 0 else 0
    maximum_usable_blocks = min(
        total_slots,
        int(math.floor(total_clients / max(1, min_visits))) if total_clients > 0 else 0
    )

    clients_with_single_slot = 0
    clients_blocked_by_duration_all_slots = 0
    for client_index in active_client_indexes:
        client_candidates = client_candidate_map.get(client_index, [])
        if len(client_candidates) == 1:
            clients_with_single_slot += 1
        if max_route_minutes > 0 and client_candidates:
            if all(
                max(1, int(round(_safe_float(candidate.get("estimated_minutes"), 0.0)))) > max_route_minutes
                for candidate in client_candidates
            ):
                clients_blocked_by_duration_all_slots += 1

    aggregate_count_capacity_upper_bound = 0
    aggregate_duration_capacity_upper_bound = 0
    slots_reaching_min_clients = 0
    slots_reaching_min_ca = 0
    slots_reaching_duration = 0
    slots_fully_eligible = 0
    slot_examples = []

    for slot_index, slot in enumerate(slots):
        slot_candidates = []
        for client_index in active_client_indexes:
            for candidate in client_candidate_map.get(client_index, []):
                if candidate.get("slot_index") == slot_index:
                    slot_candidates.append(candidate)
                    break

        candidate_count = len(slot_candidates)
        requested_max_clients = max(1, _safe_int(slot.get("requested_max_clients"), max_visits))
        hard_max_clients = max(requested_max_clients, _safe_int(slot.get("hard_max_clients"), requested_max_clients))
        usable_count_capacity = min(candidate_count, requested_max_clients, hard_max_clients)
        aggregate_count_capacity_upper_bound += usable_count_capacity

        max_clients_by_duration = usable_count_capacity
        shortest_min_visits_minutes = 0
        if max_route_minutes > 0 and candidate_count > 0:
            max_clients_by_duration = min(
                usable_count_capacity,
                _count_candidates_within_duration(slot_candidates, max_route_minutes)
            )
            shortest_min_visits_minutes = _sum_shortest_candidate_minutes(slot_candidates, min_visits)

        aggregate_duration_capacity_upper_bound += max_clients_by_duration

        max_predicted_ca_with_requested_cap = _sum_top_candidate_metric(slot_candidates, "predicted_ca", usable_count_capacity) / 10.0
        max_predicted_ca_with_min_visits = _sum_top_candidate_metric(
            slot_candidates,
            "predicted_ca",
            min(candidate_count, min_visits)
        ) / 10.0

        can_reach_min_clients = candidate_count >= min_visits
        can_reach_min_ca = min_total_ca <= 0 or max_predicted_ca_with_requested_cap >= (min_total_ca - 0.01)
        can_reach_duration = max_route_minutes <= 0 or (
            candidate_count >= min_visits and shortest_min_visits_minutes <= max_route_minutes
        )

        if can_reach_min_clients:
            slots_reaching_min_clients += 1
        if can_reach_min_ca:
            slots_reaching_min_ca += 1
        if can_reach_duration:
            slots_reaching_duration += 1

        issues = []
        if not can_reach_min_clients:
            issues.append("min_clients")
        if not can_reach_min_ca:
            issues.append("min_ca")
        if max_route_minutes > 0 and not can_reach_duration:
            issues.append("route_duration")
        if not issues:
            slots_fully_eligible += 1

        if issues:
            slot_examples.append({
                "slot_id": slot.get("id"),
                "date": slot.get("date"),
                "commercial_code": slot.get("commercial_code"),
                "commercial_label": slot.get("commercial_label"),
                "candidate_count": candidate_count,
                "requested_max_clients": requested_max_clients,
                "max_clients_by_duration": max_clients_by_duration,
                "max_predicted_ca": round(max_predicted_ca_with_requested_cap, 2),
                "max_predicted_ca_with_min_visits": round(max_predicted_ca_with_min_visits, 2),
                "shortest_min_visits_minutes": shortest_min_visits_minutes,
                "issues": issues
            })

    infeasible_reason = "exact_combination_infeasible"
    infeasible_detail = "La combinaison Min/Max, CA, duree et slots candidats ne permet aucune affectation exacte."
    if total_clients > aggregate_count_capacity_upper_bound:
        infeasible_reason = "insufficient_slot_capacity_upper_bound"
        infeasible_detail = (
            f"La capacite theorique par block reste limitee a environ {aggregate_count_capacity_upper_bound} client(s) "
            f"pour {total_clients} client(s) a affecter."
        )
    elif max_route_minutes > 0 and total_clients > aggregate_duration_capacity_upper_bound:
        infeasible_reason = "route_time_capacity_insufficient"
        infeasible_detail = (
            f"Avec une duree max de {int(round(max_route_minutes))} min, la capacite theorique tombe a "
            f"environ {aggregate_duration_capacity_upper_bound} client(s) pour {total_clients} client(s) a couvrir."
        )
    elif minimum_required_blocks > 0 and slots_reaching_min_clients < minimum_required_blocks:
        infeasible_reason = "not_enough_blocks_for_min_clients"
        infeasible_detail = (
            f"Il faut au moins {minimum_required_blocks} block(s) de {min_visits}+ client(s), "
            f"mais seulement {slots_reaching_min_clients} slot(s) candidat(s) atteignent ce minimum."
        )
    elif minimum_required_blocks > 0 and min_total_ca > 0 and slots_reaching_min_ca < minimum_required_blocks:
        infeasible_reason = "not_enough_blocks_for_min_ca"
        infeasible_detail = (
            f"Il faut au moins {minimum_required_blocks} block(s) qui puissent atteindre {round(min_total_ca, 2)} "
            f"de CA, mais seulement {slots_reaching_min_ca} slot(s) candidat(s) y arrivent theoriquement."
        )
    elif minimum_required_blocks > 0 and max_route_minutes > 0 and slots_reaching_duration < minimum_required_blocks:
        infeasible_reason = "not_enough_blocks_for_route_duration"
        infeasible_detail = (
            f"Il faut au moins {minimum_required_blocks} block(s) qui tiennent sous {int(round(max_route_minutes))} min "
            f"avec au moins {min_visits} client(s), mais seulement {slots_reaching_duration} slot(s) candidat(s) le permettent."
        )
    elif minimum_required_blocks > 0 and slots_fully_eligible < minimum_required_blocks:
        infeasible_reason = "not_enough_fully_eligible_blocks"
        infeasible_detail = (
            f"Il faut au moins {minimum_required_blocks} block(s) respectant en meme temps Min/Max, CA et duree, "
            f"mais seulement {slots_fully_eligible} slot(s) candidat(s) restent totalement eligibles."
        )

    slot_examples.sort(
        key=lambda item: (
            -len(item.get("issues", [])),
            item.get("candidate_count", 0),
            item.get("max_clients_by_duration", 0),
            item.get("max_predicted_ca", 0.0)
        )
    )

    return {
        "ortools_total_clients": total_clients,
        "ortools_total_slots": total_slots,
        "ortools_minimum_required_blocks": minimum_required_blocks,
        "ortools_maximum_usable_blocks": maximum_usable_blocks,
        "ortools_clients_with_single_slot": clients_with_single_slot,
        "ortools_clients_blocked_by_duration_all_slots": clients_blocked_by_duration_all_slots,
        "ortools_slots_reaching_min_clients": slots_reaching_min_clients,
        "ortools_slots_reaching_min_ca": slots_reaching_min_ca,
        "ortools_slots_reaching_duration": slots_reaching_duration,
        "ortools_slots_fully_eligible": slots_fully_eligible,
        "ortools_aggregate_count_capacity_upper_bound": aggregate_count_capacity_upper_bound,
        "ortools_aggregate_duration_capacity_upper_bound": aggregate_duration_capacity_upper_bound,
        "ortools_infeasible_reason": infeasible_reason,
        "ortools_infeasible_detail": infeasible_detail,
        "ortools_slot_examples": slot_examples[:6]
    }


@app.route('/api/optimize-coverage', methods=['POST'])
def optimize_coverage_plan():
    data = request.json or {}

    try:
        from coverage_optimizer import solve_coverage_plan, compute_stable_debug_hash

        result = solve_coverage_plan(data)
        if is_perf_debug_enabled() and isinstance(result, dict):
            meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
            result_hashes = dict(meta.get("result_hashes") or {})
            result_hashes["python_response_before_flask_hash"] = compute_stable_debug_hash(result)
            meta["result_hashes"] = result_hashes
            result["meta"] = meta
            probe_response = jsonify(result)
            result_hashes["flask_json_response_hash"] = compute_stable_debug_hash(probe_response.get_json(silent=True))
            meta["result_hashes"] = result_hashes
            result["meta"] = meta
        emit_coverage_optimize_debug_logs(result)
        response = jsonify(result)
        status = str(result.get("status") or "").strip().lower()
        if status == "error":
            return response, 503
        return response, 200
    except Exception as error:
        return jsonify({
            "status": "error",
            "message": f"Optimisation OR-Tools impossible: {error}"
        }), 500


@app.route('/api/analyze-coverage', methods=['POST'])
def analyze_coverage_plan():
    data = request.json or {}

    try:
        from coverage_optimizer import (
            build_coverage_analysis_summary_from_context,
            build_coverage_optimization_context,
            is_normalized_coverage_payload,
        )
        context = build_coverage_optimization_context(
            data,
            payload_already_normalized=is_normalized_coverage_payload(data)
        )
        return jsonify(build_coverage_analysis_summary_from_context(context)), 200
    except Exception as error:
        return jsonify({
            "status": "error",
            "message": f"Analyse coverage impossible: {error}"
        }), 500


if __name__ == '__main__':
    app.run(port=5001, debug=True, use_reloader=False)
