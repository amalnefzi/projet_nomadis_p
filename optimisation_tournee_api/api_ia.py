from flask import Flask, request, jsonify
import pandas as pd
import joblib
import numpy as np
import sys
import os
import json
import uuid
import hashlib
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
    'vente_avg_3',
    'qte_avg_3',
    'ca_last_30d',
    'ca_last_60d',
    'ca_last_90d',
    'qte_last_30d',
    'qte_last_60d',
    'qte_last_90d',
    'orders_last_30d',
    'orders_last_60d',
    'orders_last_90d',
    'avg_ca_per_order_90d',
    'avg_qte_per_order_90d',
    'weekday_purchase_rate',
    'days_since_last_same_weekday_order',
    'recent_ca_trend',
    'recent_qte_trend',
    'avg_price_hist',
    'month'
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

    return pymysql.connect(
        host=os.getenv('DB_HOST', 'localhost'),
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
    features = df[FEATURE_COLUMNS_BASE + ['region']].copy()
    features['region'] = features['region'].fillna('Inconnu').astype(str).str.strip()
    for col in FEATURE_COLUMNS_BASE:
        features[col] = pd.to_numeric(features[col], errors='coerce').fillna(0)
    features = pd.get_dummies(features, columns=['region'], dummy_na=False)
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
    visites_jour = max(0, float(row.get('nbr_visites_jour', 0)))
    recency_days = max(0, float(row.get('days_since_last_order', 999)))

    history_factor = min(1.0, visites_jour / 8.0)
    recency_factor = max(0.0, 1.0 - min(recency_days, 45.0) / 45.0)

    prob = (0.75 * history_factor) + (0.25 * recency_factor)
    return round(prob * 100, 1)


def stabilize_purchase_probability(model_prob_pct, hist_prob_pct, habit_score, recency_score, ca_if_buy):
    model_prob_pct = float(model_prob_pct) if pd.notna(model_prob_pct) else 0.0
    hist_prob_pct = float(hist_prob_pct) if pd.notna(hist_prob_pct) else 0.0
    habit_score = float(habit_score) if pd.notna(habit_score) else 0.0
    recency_score = float(recency_score) if pd.notna(recency_score) else 0.0
    ca_if_buy = float(ca_if_buy) if pd.notna(ca_if_buy) else 0.0

    blended = (
        (0.50 * model_prob_pct) +
        (0.25 * hist_prob_pct) +
        (0.15 * habit_score) +
        (0.10 * recency_score)
    )

    # Avoid collapsing expected value too aggressively for clients with decent
    # historical behavior and commercially relevant predicted CA.
    if ca_if_buy >= 80 and (hist_prob_pct >= 18 or habit_score >= 25):
        blended = max(blended, min(45.0, (0.60 * hist_prob_pct) + (0.40 * habit_score)))
    elif ca_if_buy >= 30 and (hist_prob_pct >= 10 or recency_score >= 20):
        blended = max(blended, min(28.0, (0.65 * hist_prob_pct) + (0.35 * recency_score)))

    return round(float(np.clip(blended, 0, 95)), 1)


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


def load_artifacts():
    global model_achat, model_ca, model_qte, model_price
    global model_affectation, feature_columns, assignment_feature_columns, assignment_classes
    global df_master, df_prefs

    print("Chargement des modeles XGBoost et des donnees...")
    try:
        model_achat = joblib.load('modele_nomadis_achat.pkl')
        model_ca = joblib.load('modele_nomadis_ca.pkl')
        model_qte = joblib.load('modele_nomadis_qte.pkl')
        model_price = joblib.load('modele_nomadis_price.pkl')
        feature_columns = joblib.load('colonnes_ia.pkl')
        df_master = pd.read_csv('master_dataset_v3.csv')
        df_master['client_code'] = df_master['client_code'].astype(str).str.strip()
        df_master['region'] = df_master['region'].fillna('Inconnu').astype(str).str.strip()
        df_master['delegation'] = df_master['delegation'].fillna('Inconnue').astype(str).str.strip() if 'delegation' in df_master.columns else 'Inconnue'
        df_master['routing_code'] = df_master['routing_code'].fillna('Inconnue').astype(str).str.strip() if 'routing_code' in df_master.columns else 'Inconnue'
        df_master['home_commercial'] = df_master['home_commercial'].fillna('Inconnu').astype(str).str.strip() if 'home_commercial' in df_master.columns else 'Inconnu'
        df_master['potentiel'] = pd.to_numeric(df_master['potentiel'], errors='coerce').fillna(0)
        for col in FEATURE_COLUMNS_BASE:
            if col in df_master.columns:
                df_master[col] = pd.to_numeric(df_master[col], errors='coerce').fillna(0)

        try:
            df_prefs = pd.read_csv('preferences_clients_produits.csv')
        except Exception:
            df_prefs = pd.read_csv('preferences_clients.csv')

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

        print("IA prete avec les modeles XGBoost Achat + CA + Quantite.")
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
                "message": "Modeles IA non charges. Lancez train_auto.py pour regenerer les artefacts XGBoost."
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

        clients_du_jour = df_master[df_master['jour_semaine'] == jour_semaine].copy()
        clients_du_jour = clients_du_jour.drop_duplicates(subset=['client_code'])
        clients_du_jour['day_of_month'] = day_of_month
        clients_du_jour['week_of_month'] = week_of_month
        clients_du_jour['days_to_month_end'] = days_to_month_end
        clients_du_jour['is_month_start'] = is_month_start
        clients_du_jour['is_month_end'] = is_month_end
        clients_du_jour['month'] = month

        if clients_du_jour.empty:
            return finalize_prediction_response(data, {"status": "error", "message": "Pas d'historique pour ce jour."})

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
        clients_du_jour['VIP'] = clients_du_jour.apply(
            lambda row: int((row['Vn_predit'] / max_vn) * 100) if max_vn > 0 else 0,
            axis=1
        )
        clients_du_jour['Score'] = clients_du_jour.apply(
            lambda row: (row['Vn_predit'] / max_vn) * 100 if max_vn > 0 else 0,
            axis=1
        )

        # Keep only clients with a credible buy signal for the requested date.
        base_filter = (
            (clients_du_jour['Prob_achat'] >= min_prob_achat) &
            (
                (clients_du_jour['Vn_predit'] >= min_vn_predit) |
                (clients_du_jour['Pred_ca_if_buy'] >= min_ca_if_buy)
            )
        )
        filtered_clients = clients_du_jour[base_filter].copy()

        if filtered_clients.empty:
            filtered_clients = clients_du_jour.copy()

        expected_buyers = int(np.ceil((clients_du_jour['Prob_achat'].clip(0, 100) / 100.0).sum()))
        dynamic_limit = int(np.clip(np.ceil(expected_buyers * selection_multiplier), min_clients_floor, max_clients_cap))
        selected_limit = max_clients_req if max_clients_req > 0 else dynamic_limit
        selected_limit = int(np.clip(selected_limit, 1, max_clients_cap))

        filtered_clients = filtered_clients.sort_values(
            ['Prob_achat', 'Vn_predit', 'Score', 'Habit_score', 'Recency_score'],
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
                "habit_score": round(float(row['Habit_score']), 1),
                "recency_score": round(float(row['Recency_score']), 1),
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
                "selection_limit": int(selected_limit)
            }
        })

    except Exception as e:
        return finalize_prediction_response(data, {"status": "error", "message": str(e)}, 500)


if __name__ == '__main__':
    app.run(port=5001, debug=True)
