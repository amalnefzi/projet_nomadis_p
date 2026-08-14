import hashlib
import json
import os
from datetime import datetime, timedelta

import pandas as pd
from sqlalchemy import text

from nomadis_feature_engineering import (
    FEATURE_COLUMNS_BASE,
    FEATURE_SCHEMA_VERSION,
    MAIN_CATEGORICAL_COLUMNS,
    build_canonical_feature_bundle,
    resolve_feature_store_serving_horizon_end_date,
    resolve_serving_data_upper_bound_date,
)


FEATURE_STORE_ROWS_TABLE = 'nomadis_client_feature_store'
FEATURE_STORE_STATE_TABLE = 'nomadis_feature_store_state'
FEATURE_STORE_STATE_KEY = 'active'
FEATURE_STORE_BUILD_TIMEOUT_SECONDS = max(
    60,
    int(os.getenv('NOMADIS_FEATURE_STORE_BUILD_TIMEOUT_SECONDS', '1800') or '1800')
)

FEATURE_STORE_BASE_COLUMNS = [
    'client_code',
    'date_doc',
    'region',
    'delegation',
    'routing_code',
    'home_commercial',
    'potentiel',
    'ca_jour',
    'qte_jour',
    'docs_jour',
    'line_items_jour',
    'product_refs_jour',
    'achat_target',
    *FEATURE_COLUMNS_BASE,
]


def _to_iso_date(value):
    if value is None or value == '':
        return None
    parsed = pd.to_datetime(value, errors='coerce')
    if pd.isna(parsed):
        return None
    return pd.Timestamp(parsed).normalize().date().isoformat()


def _to_iso_datetime(value):
    if value is None or value == '':
        return None
    parsed = pd.to_datetime(value, errors='coerce', utc=False)
    if pd.isna(parsed):
        return None
    return pd.Timestamp(parsed).to_pydatetime().isoformat()


def _serialize_json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def build_feature_store_source_summary(engine, reference_now=None, target_date=None):
    source_upper_bound = pd.Timestamp(resolve_serving_data_upper_bound_date(reference_now)).normalize()
    serving_horizon_end = pd.Timestamp(
        resolve_feature_store_serving_horizon_end_date(reference_now, target_date=target_date)
    ).normalize()
    row = None
    with engine.connect() as connection:
        row = connection.execute(text("""
            WITH source_rows AS (
                SELECT
                    e.code AS doc_code,
                    LPAD(e.client_code, 5, '0') AS client_code,
                    CAST(COALESCE(e.net_a_payer, 0) AS DECIMAL(15,3)) AS net_a_payer,
                    CASE
                        WHEN e.date REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
                             AND e.date <> '0000-00-00 00:00:00'
                             AND e.date <> '0000-00-00'
                        THEN STR_TO_DATE(e.date, '%Y-%m-%d %H:%i:%s')
                        ELSE NULL
                    END AS date_valide
                FROM entetecommercials e
                WHERE e.type IN ('facture', 'bl', 'blf')
                  AND e.net_a_payer > 0
                  AND e.client_code IS NOT NULL
                  AND e.client_code <> ''
                  AND LPAD(e.client_code, 5, '0') <> '00000'
            )
            SELECT
                MAX(DATE(date_valide)) AS source_max_date,
                COUNT(*) AS txn_count,
                COUNT(DISTINCT client_code) AS client_count,
                COUNT(DISTINCT DATE(date_valide)) AS txn_day_count,
                COALESCE(SUM(net_a_payer), 0) AS total_net_amount,
                COALESCE(MAX(doc_code), '') AS max_doc_code
            FROM source_rows
            WHERE date_valide IS NOT NULL
              AND YEAR(date_valide) >= 2001
              AND DATE(date_valide) <= DATE(:source_upper_bound)
        """), {
            'source_upper_bound': source_upper_bound.date().isoformat()
        }).mappings().first()

    has_row = row is not None
    source_max_date = _to_iso_date(row['source_max_date']) if has_row else None
    summary = {
        'feature_schema_version': FEATURE_SCHEMA_VERSION,
        'source_upper_bound_date': source_upper_bound.date().isoformat(),
        'serving_horizon_end_date': serving_horizon_end.date().isoformat(),
        'source_max_date': source_max_date,
        'txn_count': int(row['txn_count'] or 0) if has_row else 0,
        'client_count': int(row['client_count'] or 0) if has_row else 0,
        'txn_day_count': int(row['txn_day_count'] or 0) if has_row else 0,
        'total_net_amount': round(float(row['total_net_amount'] or 0.0), 3) if has_row else 0.0,
        'max_doc_code': str(row['max_doc_code'] or '').strip() if has_row else '',
    }
    summary['watermark'] = f"sha1:{hashlib.sha1(_serialize_json(summary).encode('utf8')).hexdigest()[:20]}"
    return summary


def build_feature_store_state_version(source_summary):
    payload = {
        'feature_schema_version': FEATURE_SCHEMA_VERSION,
        'source_data_watermark': source_summary.get('watermark'),
        'source_max_date': source_summary.get('source_max_date'),
        'serving_horizon_end_date': source_summary.get('serving_horizon_end_date'),
    }
    return f"sha1:{hashlib.sha1(_serialize_json(payload).encode('utf8')).hexdigest()[:20]}"


def ensure_feature_store_tables(engine):
    create_rows_sql = f"""
        CREATE TABLE IF NOT EXISTS {FEATURE_STORE_ROWS_TABLE} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            feature_state_version VARCHAR(191) NOT NULL,
            feature_schema_version VARCHAR(191) NOT NULL,
            source_data_watermark VARCHAR(191) NOT NULL,
            source_max_date DATE DEFAULT NULL,
            computed_at DATETIME DEFAULT NULL,
            client_code VARCHAR(191) NOT NULL,
            date_doc DATE NOT NULL,
            region VARCHAR(191) DEFAULT NULL,
            delegation VARCHAR(191) DEFAULT NULL,
            routing_code VARCHAR(191) DEFAULT NULL,
            home_commercial VARCHAR(191) DEFAULT NULL,
            potentiel DOUBLE DEFAULT NULL,
            ca_jour DOUBLE DEFAULT NULL,
            qte_jour DOUBLE DEFAULT NULL,
            docs_jour DOUBLE DEFAULT NULL,
            line_items_jour DOUBLE DEFAULT NULL,
            product_refs_jour DOUBLE DEFAULT NULL,
            achat_target TINYINT DEFAULT NULL,
            jour_semaine INT DEFAULT NULL,
            day_of_month INT DEFAULT NULL,
            week_of_month INT DEFAULT NULL,
            days_to_month_end INT DEFAULT NULL,
            is_month_start TINYINT DEFAULT NULL,
            is_month_end TINYINT DEFAULT NULL,
            nbr_visites_hist DOUBLE DEFAULT NULL,
            nbr_visites_jour DOUBLE DEFAULT NULL,
            days_since_last_order DOUBLE DEFAULT NULL,
            vente_last DOUBLE DEFAULT NULL,
            qte_last DOUBLE DEFAULT NULL,
            docs_last DOUBLE DEFAULT NULL,
            line_items_last DOUBLE DEFAULT NULL,
            product_refs_last DOUBLE DEFAULT NULL,
            vente_avg_3 DOUBLE DEFAULT NULL,
            qte_avg_3 DOUBLE DEFAULT NULL,
            docs_avg_3 DOUBLE DEFAULT NULL,
            line_items_avg_3 DOUBLE DEFAULT NULL,
            product_refs_avg_3 DOUBLE DEFAULT NULL,
            ca_last_7d DOUBLE DEFAULT NULL,
            ca_last_30d DOUBLE DEFAULT NULL,
            ca_last_60d DOUBLE DEFAULT NULL,
            ca_last_90d DOUBLE DEFAULT NULL,
            qte_last_7d DOUBLE DEFAULT NULL,
            qte_last_30d DOUBLE DEFAULT NULL,
            qte_last_60d DOUBLE DEFAULT NULL,
            qte_last_90d DOUBLE DEFAULT NULL,
            docs_last_30d DOUBLE DEFAULT NULL,
            docs_last_90d DOUBLE DEFAULT NULL,
            line_items_last_30d DOUBLE DEFAULT NULL,
            line_items_last_90d DOUBLE DEFAULT NULL,
            product_refs_last_30d DOUBLE DEFAULT NULL,
            product_refs_last_90d DOUBLE DEFAULT NULL,
            orders_last_7d DOUBLE DEFAULT NULL,
            orders_last_30d DOUBLE DEFAULT NULL,
            orders_last_60d DOUBLE DEFAULT NULL,
            orders_last_90d DOUBLE DEFAULT NULL,
            avg_ca_per_order_90d DOUBLE DEFAULT NULL,
            avg_qte_per_order_90d DOUBLE DEFAULT NULL,
            avg_docs_per_order_90d DOUBLE DEFAULT NULL,
            avg_line_items_per_order_90d DOUBLE DEFAULT NULL,
            avg_product_refs_per_order_90d DOUBLE DEFAULT NULL,
            weekday_purchase_rate DOUBLE DEFAULT NULL,
            days_since_last_same_weekday_order DOUBLE DEFAULT NULL,
            days_between_last_orders DOUBLE DEFAULT NULL,
            avg_days_between_orders_5 DOUBLE DEFAULT NULL,
            order_gap_ratio DOUBLE DEFAULT NULL,
            recent_ca_trend DOUBLE DEFAULT NULL,
            recent_qte_trend DOUBLE DEFAULT NULL,
            avg_price_hist DOUBLE DEFAULT NULL,
            month INT DEFAULT NULL,
            created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY nomadis_client_feature_store_unique (feature_state_version, client_code, date_doc),
            KEY nomadis_client_feature_store_lookup_idx (feature_state_version, client_code, date_doc),
            KEY nomadis_client_feature_store_date_idx (feature_state_version, date_doc)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    """
    create_state_sql = f"""
        CREATE TABLE IF NOT EXISTS {FEATURE_STORE_STATE_TABLE} (
            state_key VARCHAR(64) NOT NULL,
            active_feature_schema_version VARCHAR(191) DEFAULT NULL,
            active_feature_state_version VARCHAR(191) DEFAULT NULL,
            active_source_data_watermark VARCHAR(191) DEFAULT NULL,
            active_source_max_date DATE DEFAULT NULL,
            active_row_count INT DEFAULT NULL,
            active_client_count INT DEFAULT NULL,
            active_computed_at DATETIME DEFAULT NULL,
            active_source_summary_json LONGTEXT DEFAULT NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'missing',
            rebuild_reason VARCHAR(191) DEFAULT NULL,
            rebuild_started_at DATETIME DEFAULT NULL,
            last_completed_at DATETIME DEFAULT NULL,
            error_message TEXT DEFAULT NULL,
            created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (state_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    """
    with engine.begin() as connection:
        connection.execute(text(create_rows_sql))
        connection.execute(text(create_state_sql))
        connection.execute(text(f"""
            INSERT INTO {FEATURE_STORE_STATE_TABLE} (state_key, status)
            VALUES (:state_key, 'missing')
            ON DUPLICATE KEY UPDATE state_key = VALUES(state_key)
        """), {'state_key': FEATURE_STORE_STATE_KEY})


def read_feature_store_state(engine):
    ensure_feature_store_tables(engine)
    with engine.connect() as connection:
        row = connection.execute(text(f"""
            SELECT *
            FROM {FEATURE_STORE_STATE_TABLE}
            WHERE state_key = :state_key
            LIMIT 1
        """), {'state_key': FEATURE_STORE_STATE_KEY}).mappings().first()
    if not row:
        return {
            'state_key': FEATURE_STORE_STATE_KEY,
            'status': 'missing'
        }
    return {
        'state_key': row['state_key'],
        'active_feature_schema_version': row['active_feature_schema_version'],
        'active_feature_state_version': row['active_feature_state_version'],
        'active_source_data_watermark': row['active_source_data_watermark'],
        'active_source_max_date': _to_iso_date(row['active_source_max_date']),
        'active_row_count': int(row['active_row_count'] or 0) if row['active_row_count'] is not None else 0,
        'active_client_count': int(row['active_client_count'] or 0) if row['active_client_count'] is not None else 0,
        'active_computed_at': _to_iso_datetime(row['active_computed_at']),
        'active_source_summary': json.loads(row['active_source_summary_json']) if row['active_source_summary_json'] else None,
        'status': str(row['status'] or 'missing').strip() or 'missing',
        'rebuild_reason': row['rebuild_reason'],
        'rebuild_started_at': _to_iso_datetime(row['rebuild_started_at']),
        'last_completed_at': _to_iso_datetime(row['last_completed_at']),
        'error_message': row['error_message'],
    }


def feature_store_build_expired(state, reference_now=None):
    if not state or str(state.get('status') or '').strip() != 'building':
        return False
    started_at = pd.to_datetime(state.get('rebuild_started_at'), errors='coerce')
    if pd.isna(started_at):
        return True
    now_value = pd.Timestamp(reference_now or datetime.utcnow())
    return (now_value - started_at) > pd.Timedelta(seconds=FEATURE_STORE_BUILD_TIMEOUT_SECONDS)


def feature_store_is_current(state, source_summary):
    if not state:
        return False
    return (
        state.get('active_feature_schema_version') == FEATURE_SCHEMA_VERSION and
        state.get('active_source_data_watermark') == source_summary.get('watermark') and
        state.get('active_feature_state_version')
    )


def feature_store_covers_target_date(state, target_date):
    if not state:
        return False
    active_summary = state.get('active_source_summary') or {}
    horizon_end = pd.to_datetime(active_summary.get('serving_horizon_end_date'), errors='coerce')
    target_ts = pd.to_datetime(target_date, errors='coerce')
    if pd.isna(horizon_end) or pd.isna(target_ts):
        return False
    return pd.Timestamp(target_ts).normalize() <= pd.Timestamp(horizon_end).normalize()


def _mark_feature_store_state(engine, *, status, reason=None, error_message=None):
    with engine.begin() as connection:
        connection.execute(text(f"""
            UPDATE {FEATURE_STORE_STATE_TABLE}
            SET status = :status,
                rebuild_reason = :reason,
                rebuild_started_at = :started_at,
                error_message = :error_message
            WHERE state_key = :state_key
        """), {
            'status': status,
            'reason': reason,
            'started_at': datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S') if status == 'building' else None,
            'error_message': error_message,
            'state_key': FEATURE_STORE_STATE_KEY,
        })


def persist_feature_store_snapshot(engine, bundle, source_summary, reason='manual'):
    ensure_feature_store_tables(engine)
    features = bundle.get('features')
    if features is None:
        features = pd.DataFrame()
    else:
        features = features.copy()
    source_max_date = source_summary.get('source_max_date')
    feature_state_version = build_feature_store_state_version(source_summary)
    computed_at = datetime.utcnow().replace(microsecond=0)

    rows = features.rename(columns={
        'date': 'date_doc',
        'vente_nette': 'ca_jour',
        'qte_totale': 'qte_jour',
    }).copy()
    rows = rows.loc[:, ~rows.columns.duplicated()].copy()
    if rows.empty:
        rows = pd.DataFrame(columns=FEATURE_STORE_BASE_COLUMNS)

    for column in FEATURE_STORE_BASE_COLUMNS:
        if column not in rows.columns:
            rows[column] = None
    rows = rows[FEATURE_STORE_BASE_COLUMNS].copy()
    rows = rows.loc[:, ~rows.columns.duplicated()].copy()
    if not rows.empty:
        rows['client_code'] = rows['client_code'].astype(str).str.strip()
        rows['date_doc'] = pd.to_datetime(rows['date_doc'], errors='coerce').dt.normalize()
        rows['computed_at'] = computed_at
        rows['feature_state_version'] = feature_state_version
        rows['feature_schema_version'] = FEATURE_SCHEMA_VERSION
        rows['source_data_watermark'] = source_summary.get('watermark')
        rows['source_max_date'] = pd.to_datetime(source_max_date, errors='coerce').normalize() if source_max_date else None

    row_count = int(len(rows))
    client_count = int(rows['client_code'].nunique()) if row_count else 0

    with engine.begin() as connection:
        connection.execute(text(f"""
            DELETE FROM {FEATURE_STORE_ROWS_TABLE}
            WHERE feature_state_version = :feature_state_version
        """), {'feature_state_version': feature_state_version})

        if row_count:
            rows.to_sql(
                FEATURE_STORE_ROWS_TABLE,
                con=connection,
                if_exists='append',
                index=False,
                chunksize=1000,
                method='multi',
            )

        connection.execute(text(f"""
            UPDATE {FEATURE_STORE_STATE_TABLE}
            SET active_feature_schema_version = :active_feature_schema_version,
                active_feature_state_version = :active_feature_state_version,
                active_source_data_watermark = :active_source_data_watermark,
                active_source_max_date = :active_source_max_date,
                active_row_count = :active_row_count,
                active_client_count = :active_client_count,
                active_computed_at = :active_computed_at,
                active_source_summary_json = :active_source_summary_json,
                status = 'ready',
                rebuild_reason = :rebuild_reason,
                rebuild_started_at = NULL,
                last_completed_at = :last_completed_at,
                error_message = NULL
            WHERE state_key = :state_key
        """), {
            'active_feature_schema_version': FEATURE_SCHEMA_VERSION,
            'active_feature_state_version': feature_state_version,
            'active_source_data_watermark': source_summary.get('watermark'),
            'active_source_max_date': source_max_date,
            'active_row_count': row_count,
            'active_client_count': client_count,
            'active_computed_at': computed_at.strftime('%Y-%m-%d %H:%M:%S'),
            'active_source_summary_json': _serialize_json(source_summary),
            'rebuild_reason': reason,
            'last_completed_at': computed_at.strftime('%Y-%m-%d %H:%M:%S'),
            'state_key': FEATURE_STORE_STATE_KEY,
        })

        connection.execute(text(f"""
            DELETE FROM {FEATURE_STORE_ROWS_TABLE}
            WHERE feature_state_version <> :feature_state_version
        """), {'feature_state_version': feature_state_version})

    return {
        'feature_state_version': feature_state_version,
        'feature_schema_version': FEATURE_SCHEMA_VERSION,
        'source_data_watermark': source_summary.get('watermark'),
        'source_max_date': source_max_date,
        'row_count': row_count,
        'client_count': client_count,
        'computed_at': computed_at.isoformat(),
    }


def mark_feature_store_failed(engine, error_message, reason='refresh_failed'):
    with engine.begin() as connection:
        connection.execute(text(f"""
            UPDATE {FEATURE_STORE_STATE_TABLE}
            SET status = 'failed',
                rebuild_reason = :rebuild_reason,
                rebuild_started_at = NULL,
                error_message = :error_message
            WHERE state_key = :state_key
        """), {
            'rebuild_reason': reason,
            'error_message': str(error_message or '')[:4000],
            'state_key': FEATURE_STORE_STATE_KEY,
        })


def refresh_feature_store(engine, reason='manual', reference_now=None, target_date=None):
    ensure_feature_store_tables(engine)
    source_summary = build_feature_store_source_summary(
        engine,
        reference_now=reference_now,
        target_date=target_date,
    )
    _mark_feature_store_state(engine, status='building', reason=reason, error_message=None)
    try:
        source_max_date = source_summary.get('source_max_date')
        cutoff_date = pd.Timestamp(source_max_date).normalize() if source_max_date else pd.Timestamp(resolve_serving_data_upper_bound_date(reference_now)).normalize()
        bundle = build_canonical_feature_bundle(
            engine,
            cutoff_date=cutoff_date,
            calendar_end_date=source_summary.get('serving_horizon_end_date'),
        )
        persisted = persist_feature_store_snapshot(engine, bundle, source_summary, reason=reason)
        return {
            'status': 'ready',
            'reason': reason,
            'source_summary': source_summary,
            **persisted
        }
    except Exception as error:
        mark_feature_store_failed(engine, error, reason=reason)
        raise


def load_active_feature_store_frame(engine):
    state = read_feature_store_state(engine)
    active_version = state.get('active_feature_state_version')
    if not active_version:
        return pd.DataFrame(), state

    with engine.connect() as connection:
        rows = pd.read_sql(text(f"""
            SELECT
                client_code,
                date_doc,
                region,
                delegation,
                routing_code,
                home_commercial,
                potentiel,
                ca_jour,
                qte_jour,
                docs_jour,
                line_items_jour,
                product_refs_jour,
                achat_target,
                jour_semaine,
                day_of_month,
                week_of_month,
                days_to_month_end,
                is_month_start,
                is_month_end,
                nbr_visites_hist,
                nbr_visites_jour,
                days_since_last_order,
                vente_last,
                qte_last,
                docs_last,
                line_items_last,
                product_refs_last,
                vente_avg_3,
                qte_avg_3,
                docs_avg_3,
                line_items_avg_3,
                product_refs_avg_3,
                ca_last_7d,
                ca_last_30d,
                ca_last_60d,
                ca_last_90d,
                qte_last_7d,
                qte_last_30d,
                qte_last_60d,
                qte_last_90d,
                docs_last_30d,
                docs_last_90d,
                line_items_last_30d,
                line_items_last_90d,
                product_refs_last_30d,
                product_refs_last_90d,
                orders_last_7d,
                orders_last_30d,
                orders_last_60d,
                orders_last_90d,
                avg_ca_per_order_90d,
                avg_qte_per_order_90d,
                avg_docs_per_order_90d,
                avg_line_items_per_order_90d,
                avg_product_refs_per_order_90d,
                weekday_purchase_rate,
                days_since_last_same_weekday_order,
                days_between_last_orders,
                avg_days_between_orders_5,
                order_gap_ratio,
                recent_ca_trend,
                recent_qte_trend,
                avg_price_hist,
                month
            FROM {FEATURE_STORE_ROWS_TABLE}
            WHERE feature_state_version = :feature_state_version
            ORDER BY client_code, date_doc
        """), connection, params={'feature_state_version': active_version})

    if rows.empty:
        return rows, state

    rows['client_code'] = rows['client_code'].astype(str).str.strip()
    rows['date_doc'] = pd.to_datetime(rows['date_doc'], errors='coerce').dt.normalize()
    rows = rows.rename(columns={
        'date_doc': 'date',
        'ca_jour': 'vente_nette',
        'qte_jour': 'qte_totale',
    })
    rows['history_date'] = pd.to_datetime(rows['date'], errors='coerce').dt.normalize()
    rows['prediction_history_source'] = 'canonical_feature_store'
    return rows, state


def compute_effective_history_cutoff(prediction_date, state):
    target_date = pd.Timestamp(prediction_date).normalize()
    prediction_cutoff = target_date - pd.Timedelta(days=1)
    source_max_date = pd.to_datetime(state.get('active_source_max_date'), errors='coerce')
    if pd.isna(source_max_date):
        return prediction_cutoff
    return min(prediction_cutoff, pd.Timestamp(source_max_date).normalize())
