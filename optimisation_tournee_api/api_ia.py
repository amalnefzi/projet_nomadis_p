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
from pathlib import Path
from datetime import datetime

app = Flask(__name__)
BASE_DIR = Path(__file__).resolve().parent

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

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(errors="replace")


def load_local_env():
    env_path = BASE_DIR / '.env'
    if not env_path.exists():
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
        precision_text = (BASE_DIR / 'precision.txt').read_text(encoding='utf8').strip()
        parsed = float(precision_text)
        return parsed if np.isfinite(parsed) else 0.0
    except Exception:
        return 0.0


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
        'dataset_features_clients_jour.csv',
        'daily_demand_history.csv',
        'master_dataset_v3.csv',
        'preferences_clients_produits.csv',
        'precision.txt'
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
                item_rows = []
                for rank, (client_code, prediction) in enumerate(predictions.items(), start=1):
                    item_rows.append((
                        run_code,
                        str(client_code).strip(),
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
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
        return {"Standard": target_total}, target_total

    total_hist = sum(max(0, float(qte)) for qte in details_qte.values())
    if total_hist <= 0:
        return {"Standard": target_total}, target_total

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
        return {"Standard": 1}, 1
    return final_details, final_total


def blend_expected_quantity(prob_buy, ca_if_buy, qte_if_buy, price_if_buy, avg_price_hist):
    prob_buy = max(0.0, min(1.0, float(prob_buy)))
    ca_if_buy = max(1.0, float(ca_if_buy))
    qte_if_buy = max(1.0, float(qte_if_buy))
    price_if_buy = max(0.5, float(price_if_buy))
    avg_price_hist = float(avg_price_hist) if pd.notna(avg_price_hist) else np.nan

    expected_ca = ca_if_buy * prob_buy
    qte_from_model = qte_if_buy * prob_buy
    qte_from_price = expected_ca / price_if_buy

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

    history = pd.read_csv(history_path, low_memory=False)
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
    working['ca_jour'] = pd.to_numeric(working.get('ca_jour', 0), errors='coerce').fillna(0)
    working['qte_jour'] = pd.to_numeric(working.get('qte_jour', 0), errors='coerce').fillna(0)
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


def load_daily_demand_history(history):
    history_path = BASE_DIR / 'daily_demand_history.csv'
    if history_path.exists():
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
        "history_source": prediction_history_source or 'dataset_features_clients_jour.csv',
        "history_target_date": pd.Timestamp(target_date).normalize().date().isoformat()
    }

    if df_master.empty:
        history_meta["history_reason"] = "history_not_loaded"
        return pd.DataFrame(), history_meta

    target_ts = pd.Timestamp(target_date).normalize()
    current_day_cap = pd.Timestamp(datetime.now().date())
    available_max_date = pd.Timestamp(df_master['history_date'].max()).normalize()
    trusted_max_date = min(current_day_cap, available_max_date)
    history_cutoff = min(target_ts, trusted_max_date)

    eligible_history = df_master[
        (df_master['jour_semaine'] == int(jour_semaine)) &
        (df_master['history_date'] <= history_cutoff)
    ].copy()

    history_meta.update({
        "history_current_day_cap": current_day_cap.date().isoformat(),
        "history_available_max_date": available_max_date.date().isoformat(),
        "history_trusted_max_date": trusted_max_date.date().isoformat(),
        "history_cutoff_date": history_cutoff.date().isoformat(),
        "history_rows_scanned": int(len(eligible_history))
    })

    if eligible_history.empty:
        history_meta["history_reason"] = "no_history_before_cutoff"
        return eligible_history, history_meta

    candidates = (
        eligible_history
        .sort_values(['client_code', 'history_date'])
        .groupby('client_code', as_index=False)
        .tail(1)
        .copy()
    )

    history_meta.update({
        "history_reason": "ok",
        "history_candidate_min_date": candidates['history_date'].min().date().isoformat(),
        "history_candidate_max_date": candidates['history_date'].max().date().isoformat(),
        "history_candidates_count": int(len(candidates))
    })
    return candidates, history_meta


def load_artifacts():
    global model_achat, model_ca, model_qte, model_price
    global model_affectation, feature_columns, assignment_feature_columns, assignment_classes
    global df_master, prediction_history_source, df_daily_demand, df_prefs

    print("Chargement des modeles XGBoost et des donnees...")
    try:
        model_achat = joblib.load('modele_nomadis_achat.pkl')
        model_ca = joblib.load('modele_nomadis_ca.pkl')
        model_qte = joblib.load('modele_nomadis_qte.pkl')
        model_price = joblib.load('modele_nomadis_price.pkl')
        feature_columns = joblib.load('colonnes_ia.pkl')
        df_master = load_prediction_history()
        prediction_history_source = 'dataset_features_clients_jour.csv'
        df_daily_demand = load_daily_demand_history(df_master)

        df_prefs = pd.read_csv('preferences_clients_produits.csv')

        if 'client_code' in df_prefs.columns:
            df_prefs['client_code'] = df_prefs['client_code'].astype(str).str.strip()
        if 'qte_moyenne' in df_prefs.columns:
            df_prefs['qte_moyenne'] = pd.to_numeric(df_prefs['qte_moyenne'], errors='coerce').fillna(1)

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
        return True, "Modeles IA recharges avec succes."
    except Exception as e:
        print(f"Erreur de chargement : {e}")
        return False, str(e)


load_artifacts()


@app.route('/api/reload-models', methods=['POST'])
def reload_models():
    success, message = load_artifacts()
    return jsonify({
        "status": "success" if success else "error",
        "message": message
    }), (200 if success else 500)


@app.route('/api/predict', methods=['POST'])
def predict_tournee():
    data = request.json or {}
    try:
        if model_achat is None or model_ca is None or model_qte is None or model_price is None or not feature_columns or df_master.empty:
            return finalize_prediction_response(data, {
                "status": "error",
                "message": (
                    "Modeles IA ou historique complet non charges. "
                    "Lancez train_auto.py pour regenerer les artefacts XGBoost."
                )
            }, 503)

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
        # MySQL DAYOFWEEK()-1 scale: Sunday=0, Monday=1, ..., Saturday=6
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
            cutoff_date = history_meta.get('history_cutoff_date', date_str)
            return finalize_prediction_response(data, {
                "status": "error",
                "message": f"Pas d'historique exploitable avant le {cutoff_date} pour ce jour."
            })

        X_pred = build_features(clients_du_jour)
        achat_prob = np.clip(model_achat.predict_proba(X_pred)[:, 1], 0, 1)
        pred_ca_if_buy = np.maximum(1, np.expm1(model_ca.predict(X_pred)))
        pred_qte_if_buy = np.maximum(1, np.expm1(model_qte.predict(X_pred)))
        pred_price_if_buy = np.maximum(0.5, np.expm1(model_price.predict(X_pred)))

        clients_du_jour['Prob_modele'] = np.round(achat_prob * 100, 1)
        clients_du_jour['Pred_ca_if_buy'] = pred_ca_if_buy
        clients_du_jour['Pred_qte_if_buy'] = pred_qte_if_buy
        clients_du_jour['Prix_pred'] = pred_price_if_buy
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

        # Keep only clients with a credible buy signal for the requested date.
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
        ).head(selected_limit)

        commercial_scores_by_client = {}
        if model_affectation is not None and assignment_feature_columns and assignment_classes:
            X_assignment = build_assignment_features(filtered_clients)
            assignment_probabilities = np.clip(model_affectation.predict_proba(X_assignment), 0, 1)

            for row_index, (_, row) in enumerate(filtered_clients.iterrows()):
                raw_code = str(row['client_code']).strip()
                try:
                    code_str = str(int(float(raw_code))).zfill(5)
                except ValueError:
                    code_str = raw_code.zfill(5) if len(raw_code) < 5 else raw_code

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

        result_dict = {}
        for _, row in filtered_clients.iterrows():
            raw_code = str(row['client_code']).strip()
            try:
                code_str = str(int(float(raw_code))).zfill(5)
            except ValueError:
                code_str = raw_code.zfill(5) if len(raw_code) < 5 else raw_code

            if 'client_code' in df_prefs.columns and not df_prefs.empty:
                df_prefs_filtered = df_prefs[df_prefs['client_code'] == code_str]
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

            qte_predite = float(row['Qte_predite'])
            if qte_predite < 1 and float(row['Prob_achat']) >= 12 and float(row['Vn_predit']) >= 8:
                qte_predite = 1

            details_qte, total_qte = rebalance_quantities(qte_predite, product_weights)
            prix_moyen = float(row['Vn_predit']) / max(1, total_qte)
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

        return finalize_prediction_response(data, {
            "status": "success",
            "predictions": result_dict,
            "meta": {
                "date": date_str,
                "total_candidates": int(len(clients_du_jour)),
                "selected_clients": int(len(filtered_clients)),
                "expected_buyers_estimate": int(expected_buyers),
                "min_prob_achat": float(min_prob_achat),
                "min_vn_predit": float(min_vn_predit),
                "min_ca_if_buy": float(min_ca_if_buy),
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
                "scaled_total_qte_pred": float(budget_meta.get('scaled_total_qte_pred', 0) or 0)
            }
        })

    except Exception as e:
        return finalize_prediction_response(data, {"status": "error", "message": str(e)}, 500)


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


@app.route('/api/optimize-coverage', methods=['POST'])
def optimize_coverage_plan():
    data = request.json or {}

    try:
        try:
            from ortools.sat.python import cp_model
        except Exception as import_error:
            return jsonify({
                "status": "error",
                "message": f"OR-Tools indisponible: {import_error}. Installez `ortools` dans l'environnement Python de api_ia.py."
            }), 503

        min_visits = max(1, _safe_int(data.get('min_visits'), 20))
        max_visits = max(min_visits, _safe_int(data.get('max_visits'), 30))
        min_total_ca = max(0.0, _safe_float(data.get('min_total_ca'), 0.0))
        max_solver_seconds = max(5.0, min(90.0, _safe_float(data.get('max_solver_seconds'), 20.0)))
        max_candidate_slots = max(4, min(36, _safe_int(data.get('max_candidate_slots_per_client'), 24)))
        depot_origin = data.get('depot_origin') if isinstance(data.get('depot_origin'), dict) else {}

        raw_slots = data.get('slots') if isinstance(data.get('slots'), list) else []
        raw_clients = data.get('clients') if isinstance(data.get('clients'), list) else []
        total_clients = len(raw_clients)
        total_slots = len(raw_slots)
        average_needed = max(1, int(math.ceil(total_clients / max(total_slots, 1)))) if total_clients > 0 else 1
        default_hard_max = max(max_visits, average_needed + 6, 30)

        slots = []
        slot_id_to_index = {}
        for raw_slot in raw_slots:
            normalized = _normalize_slot_entry(raw_slot, max_visits, default_hard_max)
            if not normalized:
                continue
            slot_id_to_index[normalized["id"]] = len(slots)
            slots.append(normalized)

        clients = []
        for raw_client in raw_clients:
            normalized = _normalize_client_entry(raw_client)
            if not normalized:
                continue
            if not normalized["candidate_slots"]:
                continue
            normalized["candidate_slots"] = normalized["candidate_slots"][:max_candidate_slots]
            clients.append(normalized)

        if not slots:
            return jsonify({
                "status": "error",
                "message": "Aucun slot exploitable n'a ete fourni au solveur OR-Tools."
            }), 400

        if not clients:
            return jsonify({
                "status": "success",
                "solution": {
                    "solver_status": "EMPTY",
                    "assigned_clients": 0,
                    "unassigned_clients": 0,
                    "critical_assigned": 0,
                    "critical_unassigned": 0,
                    "slot_assignments": [],
                    "assigned_client_keys": [],
                    "unassigned_client_keys": [],
                    "total_predicted_ca": 0.0,
                    "total_planned_units": 0.0,
                    "total_capacity_clients": sum(slot["hard_max_clients"] for slot in slots),
                    "total_capacity_units": sum(slot["truck_capacity_units"] for slot in slots),
                    "notes": ["Aucun client candidat a optimiser."]
                }
            }), 200

        model = cp_model.CpModel()
        x_vars = {}
        client_candidate_map = {}

        for client_index, client in enumerate(clients):
            normalized_candidates = []
            for candidate in client["candidate_slots"]:
                slot_index = slot_id_to_index.get(candidate["slot_id"])
                if slot_index is None:
                    continue

                slot = slots[slot_index]
                units = max(
                    1,
                    int(
                        math.ceil(
                            _safe_float(client.get("planned_load_units_per_client"), 0.0) or
                            _safe_float(client.get("historical_load_units_per_client"), 0.0) or
                            _safe_float(slot.get("load_units_per_client"), 1.0) or
                            1.0
                        )
                    )
                )
                normalized_candidates.append({
                    "slot_index": slot_index,
                    "slot_id": slot["id"],
                    "predicted_ca": max(0, int(round(_safe_float(candidate.get("predicted_ca"), client["predicted_ca"]) * 10))),
                    "utility_score": int(round(_safe_float(candidate.get("utility_score"), 0.0) * 10)),
                    "distance_penalty": int(round(max(0.0, client["distance_km"]) * 10)),
                    "units": units
                })

            if not normalized_candidates:
                continue

            client_candidate_map[client_index] = normalized_candidates
            for candidate in normalized_candidates:
                slot_index = candidate["slot_index"]
                x_vars[(client_index, slot_index)] = model.NewBoolVar(f"x_{client_index}_{slot_index}")

        active_client_indexes = sorted(client_candidate_map.keys())
        if not active_client_indexes:
            return jsonify({
                "status": "error",
                "message": "Aucun client n'a de slot candidat exploitable pour OR-Tools."
            }), 400

        count_vars = {}
        used_vars = {}
        over_max_vars = {}
        under_min_vars = {}
        ca_shortfall_vars = {}

        for client_index in active_client_indexes:
            vars_for_client = [
                x_vars[(client_index, candidate["slot_index"])]
                for candidate in client_candidate_map[client_index]
            ]
            model.Add(sum(vars_for_client) <= 1)

        for slot_index, slot in enumerate(slots):
            slot_assignment_vars = []
            slot_units_terms = []
            slot_ca_terms = []

            for client_index in active_client_indexes:
                for candidate in client_candidate_map[client_index]:
                    if candidate["slot_index"] != slot_index:
                        continue
                    variable = x_vars[(client_index, slot_index)]
                    slot_assignment_vars.append(variable)
                    slot_units_terms.append(candidate["units"] * variable)
                    slot_ca_terms.append(candidate["predicted_ca"] * variable)

            count_var = model.NewIntVar(0, max(1, len(active_client_indexes)), f"count_{slot_index}")
            model.Add(count_var == sum(slot_assignment_vars))
            model.Add(count_var <= max(1, slot["hard_max_clients"]))
            count_vars[slot_index] = count_var

            used_var = model.NewBoolVar(f"used_{slot_index}")
            model.Add(count_var >= 1).OnlyEnforceIf(used_var)
            model.Add(count_var == 0).OnlyEnforceIf(used_var.Not())
            used_vars[slot_index] = used_var

            if slot["truck_capacity_units"] > 0:
                model.Add(sum(slot_units_terms) <= slot["truck_capacity_units"])

            over_max = model.NewIntVar(0, max(1, slot["hard_max_clients"]), f"over_max_{slot_index}")
            model.Add(over_max >= count_var - max(1, slot["requested_max_clients"]))
            over_max_vars[slot_index] = over_max

            under_min = model.NewIntVar(0, max(1, min_visits), f"under_min_{slot_index}")
            model.Add(under_min >= (min_visits * used_var) - count_var)
            under_min_vars[slot_index] = under_min

            if min_total_ca > 0:
                shortfall_cap = max(0, int(round(min_total_ca * 10)))
                shortfall = model.NewIntVar(0, shortfall_cap, f"ca_shortfall_{slot_index}")
                model.Add(sum(slot_ca_terms) + shortfall >= shortfall_cap * used_var)
                ca_shortfall_vars[slot_index] = shortfall

        objective_terms = []
        for client_index in active_client_indexes:
            client = clients[client_index]
            critical_weight = 1_000_000 if client["is_critical_coverage"] else 200_000
            for candidate in client_candidate_map[client_index]:
                variable = x_vars[(client_index, candidate["slot_index"])]
                objective_terms.append(critical_weight * variable)
                objective_terms.append(candidate["predicted_ca"] * 20 * variable)
                objective_terms.append(candidate["utility_score"] * 5 * variable)
                objective_terms.append(-candidate["distance_penalty"] * variable)

        for slot_index in range(len(slots)):
            objective_terms.append(-over_max_vars[slot_index] * 2_000)
            objective_terms.append(-under_min_vars[slot_index] * 1_000)
            if slot_index in ca_shortfall_vars:
                objective_terms.append(-ca_shortfall_vars[slot_index] * 10)

        model.Maximize(sum(objective_terms))

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = max_solver_seconds
        solver.parameters.num_search_workers = max(1, min(8, os.cpu_count() or 1))
        solver.parameters.log_search_progress = False

        status = solver.Solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return jsonify({
                "status": "error",
                "message": "Le solveur OR-Tools n'a trouve aucune solution exploitable."
            }), 422

        solver_status = (
            "OPTIMAL" if status == cp_model.OPTIMAL
            else "FEASIBLE" if status == cp_model.FEASIBLE
            else str(status)
        )

        slot_assignments = []
        assigned_client_keys = []
        unassigned_client_keys = []
        total_predicted_ca = 0.0
        total_planned_units = 0.0
        critical_assigned = 0

        for slot_index, slot in enumerate(slots):
            assigned_clients = []
            total_units_slot = 0
            total_ca_slot = 0.0

            for client_index in active_client_indexes:
                matched_candidate = None
                for candidate in client_candidate_map[client_index]:
                    if candidate["slot_index"] == slot_index:
                        matched_candidate = candidate
                        break
                if not matched_candidate:
                    continue

                variable = x_vars[(client_index, slot_index)]
                if solver.Value(variable) != 1:
                    continue

                client = clients[client_index]
                assigned_clients.append({
                    "client_key": client["client_key"],
                    "client_code": client["client_code"],
                    "nom": client["nom"],
                    "latitude": client["latitude"],
                    "longitude": client["longitude"],
                    "predicted_ca": client["predicted_ca"],
                    "utility_score": matched_candidate["utility_score"],
                    "is_critical_coverage": client["is_critical_coverage"]
                })
                assigned_client_keys.append(client["client_key"])
                total_units_slot += matched_candidate["units"]
                total_ca_slot += matched_candidate["predicted_ca"] / 10.0
                if client["is_critical_coverage"]:
                    critical_assigned += 1

            if not assigned_clients:
                continue

            ordered_client_keys = _nearest_neighbor_client_keys(assigned_clients, depot_origin)
            slot_assignments.append({
                "slot_id": slot["id"],
                "client_keys": ordered_client_keys,
                "count": len(ordered_client_keys),
                "total_predicted_ca": round(total_ca_slot, 2),
                "total_units": float(total_units_slot),
                "over_requested_max": int(solver.Value(over_max_vars[slot_index])),
                "under_requested_min": int(solver.Value(under_min_vars[slot_index])),
                "ca_shortfall": round((solver.Value(ca_shortfall_vars[slot_index]) / 10.0), 2) if slot_index in ca_shortfall_vars else 0.0
            })
            total_predicted_ca += total_ca_slot
            total_planned_units += total_units_slot

        assigned_client_key_set = set(assigned_client_keys)
        for client_index in active_client_indexes:
            client_key = clients[client_index]["client_key"]
            if client_key not in assigned_client_key_set:
                unassigned_client_keys.append(client_key)

        critical_candidates = sum(1 for client in clients if client["is_critical_coverage"])
        critical_unassigned = max(0, critical_candidates - critical_assigned)
        block_sizes = [assignment["count"] for assignment in slot_assignments if assignment["count"] > 0]

        notes = []
        if unassigned_client_keys:
            notes.append(
                f"{len(unassigned_client_keys)} client(s) n'ont pas pu etre affectes sans depasser les contraintes du solveur."
            )
        if any(item["over_requested_max"] > 0 for item in slot_assignments):
            notes.append("Certaines tournees depassent le max demande pour conserver une meilleure couverture.")
        if any(item["under_requested_min"] > 0 for item in slot_assignments):
            notes.append("Certaines tournees restent sous le minimum demande pour eviter de laisser des clients sans affectation.")
        if min_total_ca > 0 and any(item["ca_shortfall"] > 0 for item in slot_assignments):
            notes.append("Le seuil minimum de CA journalier n'est pas atteint sur tous les blocks.")

        return jsonify({
            "status": "success",
            "solution": {
                "solver_status": solver_status,
                "assigned_clients": len(assigned_client_key_set),
                "unassigned_clients": len(unassigned_client_keys),
                "critical_assigned": critical_assigned,
                "critical_unassigned": critical_unassigned,
                "slot_assignments": slot_assignments,
                "assigned_client_keys": sorted(assigned_client_key_set),
                "unassigned_client_keys": unassigned_client_keys,
                "total_predicted_ca": round(total_predicted_ca, 2),
                "total_planned_units": round(float(total_planned_units), 2),
                "total_capacity_clients": sum(slot["hard_max_clients"] for slot in slots),
                "total_capacity_units": sum(slot["truck_capacity_units"] for slot in slots),
                "actual_min_clients_per_block": min(block_sizes) if block_sizes else 0,
                "actual_max_clients_per_block": max(block_sizes) if block_sizes else 0,
                "actual_blocks_count": len(slot_assignments),
                "objective_value": float(solver.ObjectiveValue()),
                "notes": notes
            }
        }), 200

    except Exception as error:
        return jsonify({
            "status": "error",
            "message": f"Optimisation OR-Tools impossible: {error}"
        }), 500


if __name__ == '__main__':
    app.run(port=5001, debug=True)
