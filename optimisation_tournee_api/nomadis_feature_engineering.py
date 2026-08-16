import hashlib
import os
from typing import Optional, Sequence

import numpy as np
import pandas as pd
from sqlalchemy import bindparam, text


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

FEATURE_ENGINE_VERSION = 'nomadis_feature_engine_v1'
FEATURE_ENGINE_SIGNATURE_FIELDS = {
    'feature_engine_version': FEATURE_ENGINE_VERSION,
    'feature_columns_base': FEATURE_COLUMNS_BASE,
    'main_categorical_columns': MAIN_CATEGORICAL_COLUMNS,
    'assignment_categorical_columns': ASSIGNMENT_CATEGORICAL_COLUMNS
}


def build_feature_schema_version():
    payload = repr(FEATURE_ENGINE_SIGNATURE_FIELDS).encode('utf8')
    return f"sha1:{hashlib.sha1(payload).hexdigest()[:20]}"


FEATURE_SCHEMA_VERSION = build_feature_schema_version()


def get_mysql_url():
    host = os.getenv('DB_HOST', 'localhost')
    port = os.getenv('DB_PORT', '3306').strip() or '3306'
    user = os.getenv('DB_USER', 'root')
    password = os.getenv('DB_PASS', '')
    database = os.getenv('DB_NAME', 'dist_utic')
    return f"mysql+pymysql://{user}:{password}@{host}:{port}/{database}"


def build_feature_frame(df):
    features = df[FEATURE_COLUMNS_BASE + MAIN_CATEGORICAL_COLUMNS].copy()
    for col in MAIN_CATEGORICAL_COLUMNS:
        features[col] = features[col].fillna('Inconnu').astype(str).str.strip()
    for col in FEATURE_COLUMNS_BASE:
        features[col] = pd.to_numeric(features[col], errors='coerce').fillna(0)
    features = pd.get_dummies(features, columns=MAIN_CATEGORICAL_COLUMNS, dummy_na=False)
    return features


def build_assignment_feature_frame(df):
    features = df[FEATURE_COLUMNS_BASE + ASSIGNMENT_CATEGORICAL_COLUMNS].copy()
    for col in FEATURE_COLUMNS_BASE:
        features[col] = pd.to_numeric(features[col], errors='coerce').fillna(0)
    for col in ASSIGNMENT_CATEGORICAL_COLUMNS:
        features[col] = features[col].fillna('Inconnu').astype(str).str.strip()
    features = pd.get_dummies(features, columns=ASSIGNMENT_CATEGORICAL_COLUMNS, dummy_na=False)
    return features


def _normalize_client_codes(client_codes: Optional[Sequence[str]]):
    normalized = []
    for raw_code in client_codes or []:
        code = str(raw_code or '').strip()
        if not code:
            continue
        normalized.append(code.zfill(5))
    return sorted(set(normalized))


def get_base_dataset_query():
    return """
        WITH doc_base AS (
            SELECT
                LPAD(e.client_code, 5, '0') AS client_code,
                e.code AS doc_code,
                CASE
                    WHEN e.date REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
                         AND e.date <> '0000-00-00 00:00:00'
                         AND e.date <> '0000-00-00'
                    THEN STR_TO_DATE(e.date, '%Y-%m-%d %H:%i:%s')
                    ELSE NULL
                END AS date_valide,
                COALESCE(c.region, 'Inconnu') AS region,
                COALESCE(c.delegation, 'Inconnue') AS delegation,
                COALESCE(c.routing_code, 'Inconnue') AS routing_code,
                COALESCE(NULLIF(TRIM(c.user_code), ''), 'Inconnu') AS home_commercial,
                COALESCE(c.potentiel, 0) AS potentiel,
                CAST(COALESCE(e.net_a_payer, 0) AS DECIMAL(15,3)) AS net_a_payer
            FROM entetecommercials e
            JOIN clients c ON e.client_code = c.code
            WHERE e.type IN ('facture', 'bl', 'blf')
              AND e.net_a_payer > 0
              AND e.client_code IS NOT NULL
              AND e.client_code <> ''
              AND LPAD(e.client_code, 5, '0') <> '00000'
        ),
        line_stats AS (
            SELECT
                l.entetecommercial_code AS doc_code,
                SUM(COALESCE(l.quantite, 0)) AS qte_doc,
                COUNT(*) AS line_items_doc,
                COUNT(DISTINCT CASE
                    WHEN COALESCE(NULLIF(TRIM(l.produit_code), ''), '') <> '' THEN l.produit_code
                    ELSE NULL
                END) AS product_refs_doc
            FROM lignecommercials l
            GROUP BY l.entetecommercial_code
        )
        SELECT
            d.client_code,
            DATE(d.date_valide) AS date_doc,
            DAYOFWEEK(d.date_valide) - 1 AS jour_semaine,
            d.region,
            d.delegation,
            d.routing_code,
            d.home_commercial,
            d.potentiel,
            SUM(d.net_a_payer) AS ca_jour,
            SUM(COALESCE(ls.qte_doc, 0)) AS qte_jour,
            COUNT(DISTINCT d.doc_code) AS docs_jour,
            SUM(COALESCE(ls.line_items_doc, 0)) AS line_items_jour,
            SUM(COALESCE(ls.product_refs_doc, 0)) AS product_refs_jour
        FROM doc_base d
        LEFT JOIN line_stats ls ON d.doc_code = ls.doc_code
        WHERE d.date_valide IS NOT NULL
          AND YEAR(d.date_valide) >= 2001
        GROUP BY
            d.client_code,
            DATE(d.date_valide),
            DAYOFWEEK(d.date_valide) - 1,
            d.region,
            d.delegation,
            d.routing_code,
            d.home_commercial,
            d.potentiel
        ORDER BY d.client_code, date_doc
    """


def get_assignment_dataset_query():
    return """
        SELECT
            t.client_code,
            DATE(t.date_valide) AS date_doc,
            DAYOFWEEK(t.date_valide) - 1 AS jour_semaine,
            t.commercial_code
        FROM (
            SELECT
                LPAD(e.client_code, 5, '0') AS client_code,
                CASE
                    WHEN e.date REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
                         AND e.date <> '0000-00-00 00:00:00'
                         AND e.date <> '0000-00-00'
                    THEN STR_TO_DATE(e.date, '%Y-%m-%d %H:%i:%s')
                    ELSE NULL
                END AS date_valide,
                COALESCE(
                    NULLIF(TRIM(e.commercial_code), ''),
                    NULLIF(TRIM(e.user_code), ''),
                    NULLIF(TRIM(c.user_code), ''),
                    'Inconnu'
                ) AS commercial_code
            FROM entetecommercials e
            JOIN clients c ON e.client_code = c.code
            WHERE e.type IN ('facture', 'bl', 'blf')
              AND e.net_a_payer > 0
              AND e.client_code IS NOT NULL
              AND e.client_code <> ''
              AND LPAD(e.client_code, 5, '0') <> '00000'
        ) t
        WHERE t.date_valide IS NOT NULL
          AND YEAR(t.date_valide) >= 2001
          AND t.commercial_code <> 'Inconnu'
        GROUP BY
            t.client_code,
            DATE(t.date_valide),
            DAYOFWEEK(t.date_valide) - 1,
            t.commercial_code
        ORDER BY t.client_code, date_doc
    """


def get_preferences_query(cutoff_date):
    cutoff_sql = pd.Timestamp(cutoff_date).date().isoformat()
    return f"""
        SELECT
            t.client_code,
            COALESCE(t.produit_code, 'Divers') AS produit_code,
            COALESCE(t.produit_code, 'Divers') AS produit_nom,
            SUM(t.quantite) / NULLIF(COUNT(DISTINCT t.doc_code), 0) AS qte_moyenne
        FROM (
            SELECT
                LPAD(e.client_code, 5, '0') AS client_code,
                e.code AS doc_code,
                COALESCE(p.sousfamille_code, 'Divers') AS produit_code,
                COALESCE(l.quantite, 0) AS quantite,
                CASE
                    WHEN e.date REGEXP '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}} [0-9]{{2}}:[0-9]{{2}}:[0-9]{{2}}$'
                         AND e.date <> '0000-00-00 00:00:00'
                         AND e.date <> '0000-00-00'
                    THEN DATE(STR_TO_DATE(e.date, '%Y-%m-%d %H:%i:%s'))
                    ELSE NULL
                END AS date_valide
            FROM lignecommercials l
            JOIN entetecommercials e ON l.entetecommercial_code = e.code
            JOIN produits p ON l.produit_code = p.code
            WHERE e.type IN ('facture', 'bl', 'blf')
              AND e.net_a_payer > 0
              AND e.client_code IS NOT NULL
              AND e.client_code <> ''
              AND LPAD(e.client_code, 5, '0') <> '00000'
        ) t
        WHERE t.date_valide IS NOT NULL
          AND YEAR(t.date_valide) >= 2001
          AND t.date_valide <= DATE('{cutoff_sql}')
        GROUP BY t.client_code, t.produit_code
    """


def build_dense_training_panel(df_base, calendar_dates=None):
    if calendar_dates is None:
        calendar_values = sorted(df_base['date'].dropna().unique())
    else:
        calendar_values = sorted(pd.to_datetime(pd.Series(calendar_dates), errors='coerce').dropna().unique())
    calendar = pd.DataFrame({'date': calendar_values})
    clients = (
        df_base.sort_values('date')
        .groupby('client_code', as_index=False)
        .agg({
            'region': 'last',
            'delegation': 'last',
            'routing_code': 'last',
            'home_commercial': 'last',
            'potentiel': 'last'
        })
    )

    panel = clients[['client_code']].merge(calendar, how='cross')
    panel = panel.merge(clients, on='client_code', how='left')
    panel = panel.merge(
        df_base[['client_code', 'date', 'vente_nette', 'qte_totale', 'docs_jour', 'line_items_jour', 'product_refs_jour']],
        on=['client_code', 'date'],
        how='left'
    )

    panel['vente_nette'] = pd.to_numeric(panel['vente_nette'], errors='coerce').fillna(0)
    panel['qte_totale'] = pd.to_numeric(panel['qte_totale'], errors='coerce').fillna(0)
    panel['docs_jour'] = pd.to_numeric(panel['docs_jour'], errors='coerce').fillna(0)
    panel['line_items_jour'] = pd.to_numeric(panel['line_items_jour'], errors='coerce').fillna(0)
    panel['product_refs_jour'] = pd.to_numeric(panel['product_refs_jour'], errors='coerce').fillna(0)
    panel['achat_target'] = (panel['vente_nette'] > 0).astype(int)
    panel['jour_semaine'] = ((panel['date'].dt.weekday + 1) % 7).astype(int)
    panel['day_of_month'] = panel['date'].dt.day.astype(int)
    panel['week_of_month'] = (((panel['date'].dt.day - 1) // 7) + 1).astype(int)
    month_end = panel['date'] + pd.offsets.MonthEnd(0)
    panel['days_to_month_end'] = (month_end.dt.day - panel['date'].dt.day).astype(int)
    panel['is_month_start'] = (panel['date'].dt.day <= 7).astype(int)
    panel['is_month_end'] = (panel['days_to_month_end'] <= 6).astype(int)
    panel['month'] = panel['date'].dt.month.astype(int)
    return panel.sort_values(['client_code', 'date']).reset_index(drop=True)


def enrich_panel_features(group):
    group = group.sort_values('date').copy()

    prev_orders = group['achat_target'].shift(1).fillna(0)
    group['nbr_visites_hist'] = prev_orders.cumsum()
    group['nbr_visites_jour'] = group.groupby('jour_semaine')['achat_target'].transform(lambda s: s.cumsum() - s)

    last_purchase_date = group['date'].where(group['achat_target'] == 1).ffill().shift(1)
    group['days_since_last_order'] = (group['date'] - last_purchase_date).dt.days

    group['vente_last'] = group['vente_nette'].where(group['achat_target'] == 1).ffill().shift(1)
    group['qte_last'] = group['qte_totale'].where(group['achat_target'] == 1).ffill().shift(1)
    group['docs_last'] = group['docs_jour'].where(group['achat_target'] == 1).ffill().shift(1)
    group['line_items_last'] = group['line_items_jour'].where(group['achat_target'] == 1).ffill().shift(1)
    group['product_refs_last'] = group['product_refs_jour'].where(group['achat_target'] == 1).ffill().shift(1)

    positive_only = group.loc[
        group['achat_target'] == 1,
        ['date', 'vente_nette', 'qte_totale', 'docs_jour', 'line_items_jour', 'product_refs_jour']
    ].copy()
    if positive_only.empty:
        group['vente_avg_3'] = np.nan
        group['qte_avg_3'] = np.nan
        group['docs_avg_3'] = np.nan
        group['line_items_avg_3'] = np.nan
        group['product_refs_avg_3'] = np.nan
        group['days_between_last_orders'] = np.nan
        group['avg_days_between_orders_5'] = np.nan
    else:
        positive_only['vente_avg_3'] = positive_only['vente_nette'].shift(1).rolling(3, min_periods=1).mean()
        positive_only['qte_avg_3'] = positive_only['qte_totale'].shift(1).rolling(3, min_periods=1).mean()
        positive_only['docs_avg_3'] = positive_only['docs_jour'].shift(1).rolling(3, min_periods=1).mean()
        positive_only['line_items_avg_3'] = positive_only['line_items_jour'].shift(1).rolling(3, min_periods=1).mean()
        positive_only['product_refs_avg_3'] = positive_only['product_refs_jour'].shift(1).rolling(3, min_periods=1).mean()
        positive_only['days_between_last_orders'] = positive_only['date'].diff().dt.days
        positive_only['avg_days_between_orders_5'] = positive_only['days_between_last_orders'].shift(1).rolling(5, min_periods=1).mean()
        group = pd.merge_asof(
            group,
            positive_only[
                [
                    'date',
                    'vente_avg_3',
                    'qte_avg_3',
                    'docs_avg_3',
                    'line_items_avg_3',
                    'product_refs_avg_3',
                    'days_between_last_orders',
                    'avg_days_between_orders_5'
                ]
            ].sort_values('date'),
            on='date',
            direction='backward',
            allow_exact_matches=False
        )

    shifted = group[
        ['date', 'vente_nette', 'qte_totale', 'docs_jour', 'line_items_jour', 'product_refs_jour', 'achat_target']
    ].copy().set_index('date')
    shifted['vente_prev'] = shifted['vente_nette'].shift(1).fillna(0)
    shifted['qte_prev'] = shifted['qte_totale'].shift(1).fillna(0)
    shifted['docs_prev'] = shifted['docs_jour'].shift(1).fillna(0)
    shifted['line_items_prev'] = shifted['line_items_jour'].shift(1).fillna(0)
    shifted['product_refs_prev'] = shifted['product_refs_jour'].shift(1).fillna(0)
    shifted['orders_prev'] = shifted['achat_target'].shift(1).fillna(0)

    group['ca_last_7d'] = shifted['vente_prev'].rolling('7D').sum().to_numpy()
    group['ca_last_30d'] = shifted['vente_prev'].rolling('30D').sum().to_numpy()
    group['ca_last_60d'] = shifted['vente_prev'].rolling('60D').sum().to_numpy()
    group['ca_last_90d'] = shifted['vente_prev'].rolling('90D').sum().to_numpy()
    group['qte_last_7d'] = shifted['qte_prev'].rolling('7D').sum().to_numpy()
    group['qte_last_30d'] = shifted['qte_prev'].rolling('30D').sum().to_numpy()
    group['qte_last_60d'] = shifted['qte_prev'].rolling('60D').sum().to_numpy()
    group['qte_last_90d'] = shifted['qte_prev'].rolling('90D').sum().to_numpy()
    group['docs_last_30d'] = shifted['docs_prev'].rolling('30D').sum().to_numpy()
    group['docs_last_90d'] = shifted['docs_prev'].rolling('90D').sum().to_numpy()
    group['line_items_last_30d'] = shifted['line_items_prev'].rolling('30D').sum().to_numpy()
    group['line_items_last_90d'] = shifted['line_items_prev'].rolling('90D').sum().to_numpy()
    group['product_refs_last_30d'] = shifted['product_refs_prev'].rolling('30D').sum().to_numpy()
    group['product_refs_last_90d'] = shifted['product_refs_prev'].rolling('90D').sum().to_numpy()
    group['orders_last_7d'] = shifted['orders_prev'].rolling('7D').sum().to_numpy()
    group['orders_last_30d'] = shifted['orders_prev'].rolling('30D').sum().to_numpy()
    group['orders_last_60d'] = shifted['orders_prev'].rolling('60D').sum().to_numpy()
    group['orders_last_90d'] = shifted['orders_prev'].rolling('90D').sum().to_numpy()

    cumulative_ca = shifted['vente_prev'].cumsum()
    cumulative_qte = shifted['qte_prev'].cumsum()
    group['avg_price_hist'] = (cumulative_ca / cumulative_qte.replace(0, np.nan)).to_numpy()
    group['avg_ca_per_order_90d'] = group['ca_last_90d'] / group['orders_last_90d'].replace(0, np.nan)
    group['avg_qte_per_order_90d'] = group['qte_last_90d'] / group['orders_last_90d'].replace(0, np.nan)
    group['avg_docs_per_order_90d'] = group['docs_last_90d'] / group['orders_last_90d'].replace(0, np.nan)
    group['avg_line_items_per_order_90d'] = group['line_items_last_90d'] / group['orders_last_90d'].replace(0, np.nan)
    group['avg_product_refs_per_order_90d'] = group['product_refs_last_90d'] / group['orders_last_90d'].replace(0, np.nan)

    group['weekday_purchase_rate'] = group['nbr_visites_jour'] / group['nbr_visites_hist'].replace(0, np.nan)

    last_same_weekday_date = group['date'].where(group['achat_target'] == 1).groupby(group['jour_semaine']).ffill().shift(1)
    group['days_since_last_same_weekday_order'] = (group['date'] - last_same_weekday_date).dt.days

    group['recent_ca_trend'] = group['ca_last_30d'] / group['ca_last_90d'].replace(0, np.nan)
    group['recent_qte_trend'] = group['qte_last_30d'] / group['qte_last_90d'].replace(0, np.nan)
    group['order_gap_ratio'] = group['days_since_last_order'] / group['avg_days_between_orders_5'].replace(0, np.nan)
    return group


def compute_feature_default_values(df):
    positive_sales = df.loc[df['vente_nette'] > 0, 'vente_nette']
    positive_qte = df.loc[df['qte_totale'] > 0, 'qte_totale']
    positive_docs = df.loc[df['docs_jour'] > 0, 'docs_jour']
    positive_line_items = df.loc[df['line_items_jour'] > 0, 'line_items_jour']
    positive_product_refs = df.loc[df['product_refs_jour'] > 0, 'product_refs_jour']
    price_series = df['vente_nette'] / df['qte_totale'].replace(0, np.nan)
    return {
        'nbr_visites_hist': 0,
        'nbr_visites_jour': 0,
        'days_since_last_order': 999,
        'vente_last': float(positive_sales.median() if not positive_sales.empty else 0),
        'qte_last': float(positive_qte.median() if not positive_qte.empty else 0),
        'docs_last': float(positive_docs.median() if not positive_docs.empty else 0),
        'line_items_last': float(positive_line_items.median() if not positive_line_items.empty else 0),
        'product_refs_last': float(positive_product_refs.median() if not positive_product_refs.empty else 0),
        'vente_avg_3': float(positive_sales.median() if not positive_sales.empty else 0),
        'qte_avg_3': float(positive_qte.median() if not positive_qte.empty else 0),
        'docs_avg_3': float(positive_docs.median() if not positive_docs.empty else 0),
        'line_items_avg_3': float(positive_line_items.median() if not positive_line_items.empty else 0),
        'product_refs_avg_3': float(positive_product_refs.median() if not positive_product_refs.empty else 0),
        'ca_last_7d': 0,
        'ca_last_30d': 0,
        'ca_last_60d': 0,
        'ca_last_90d': 0,
        'qte_last_7d': 0,
        'qte_last_30d': 0,
        'qte_last_60d': 0,
        'qte_last_90d': 0,
        'docs_last_30d': 0,
        'docs_last_90d': 0,
        'line_items_last_30d': 0,
        'line_items_last_90d': 0,
        'product_refs_last_30d': 0,
        'product_refs_last_90d': 0,
        'orders_last_7d': 0,
        'orders_last_30d': 0,
        'orders_last_60d': 0,
        'orders_last_90d': 0,
        'avg_ca_per_order_90d': float(positive_sales.median() if not positive_sales.empty else 0),
        'avg_qte_per_order_90d': float(positive_qte.median() if not positive_qte.empty else 0),
        'avg_docs_per_order_90d': float(positive_docs.median() if not positive_docs.empty else 0),
        'avg_line_items_per_order_90d': float(positive_line_items.median() if not positive_line_items.empty else 0),
        'avg_product_refs_per_order_90d': float(positive_product_refs.median() if not positive_product_refs.empty else 0),
        'weekday_purchase_rate': 0,
        'days_since_last_same_weekday_order': 999,
        'days_between_last_orders': 30,
        'avg_days_between_orders_5': 30,
        'order_gap_ratio': 1,
        'recent_ca_trend': 0,
        'recent_qte_trend': 0,
        'avg_price_hist': float(price_series.median() if not price_series.dropna().empty else 0)
    }


def fill_feature_defaults(df, default_values=None):
    numeric_defaults = default_values or compute_feature_default_values(df)

    for col, default_value in numeric_defaults.items():
        df[col] = pd.to_numeric(df[col], errors='coerce').fillna(default_value)

    df['potentiel'] = pd.to_numeric(df['potentiel'], errors='coerce').fillna(0)
    df['jour_semaine'] = pd.to_numeric(df['jour_semaine'], errors='coerce').fillna(0).astype(int)
    df['day_of_month'] = pd.to_numeric(df['day_of_month'], errors='coerce').fillna(1).astype(int)
    df['week_of_month'] = pd.to_numeric(df['week_of_month'], errors='coerce').fillna(1).astype(int)
    df['days_to_month_end'] = pd.to_numeric(df['days_to_month_end'], errors='coerce').fillna(0).astype(int)
    df['is_month_start'] = pd.to_numeric(df['is_month_start'], errors='coerce').fillna(0).astype(int)
    df['is_month_end'] = pd.to_numeric(df['is_month_end'], errors='coerce').fillna(0).astype(int)
    df['month'] = pd.to_numeric(df['month'], errors='coerce').fillna(1).astype(int)
    return df


def resolve_data_cutoff_date():
    raw_cutoff = str(
        os.getenv('IA_DATA_MAX_DATE') or
        os.getenv('NOMADIS_DATA_MAX_DATE') or
        ''
    ).strip()
    if raw_cutoff:
        cutoff = pd.to_datetime(raw_cutoff, errors='coerce')
        if pd.isna(cutoff):
            raise RuntimeError(
                f"IA_DATA_MAX_DATE invalide: {raw_cutoff!r}. Utilisez le format YYYY-MM-DD."
            )
        return pd.Timestamp(cutoff).normalize()
    return pd.Timestamp.now().normalize()


def resolve_serving_data_upper_bound_date(reference_now=None):
    raw_cutoff = str(
        os.getenv('IA_DATA_MAX_DATE') or
        os.getenv('NOMADIS_DATA_MAX_DATE') or
        ''
    ).strip()
    if raw_cutoff:
        cutoff = pd.to_datetime(raw_cutoff, errors='coerce')
        if pd.isna(cutoff):
            raise RuntimeError(
                f"IA_DATA_MAX_DATE invalide: {raw_cutoff!r}. Utilisez le format YYYY-MM-DD."
            )
        return pd.Timestamp(cutoff).normalize()

    current_reference = pd.Timestamp(reference_now or pd.Timestamp.now()).normalize()
    return current_reference - pd.Timedelta(days=1)


def resolve_feature_store_serving_horizon_days():
    raw_value = str(
        os.getenv('NOMADIS_FEATURE_STORE_SERVING_HORIZON_DAYS') or
        '120'
    ).strip()
    try:
        parsed = int(raw_value)
    except Exception:
        parsed = 120
    return max(30, parsed)


def resolve_feature_store_serving_horizon_end_date(reference_now=None, target_date=None):
    serving_upper_bound = pd.Timestamp(resolve_serving_data_upper_bound_date(reference_now)).normalize()
    horizon_end = serving_upper_bound + pd.Timedelta(days=resolve_feature_store_serving_horizon_days())
    target_ts = pd.to_datetime(target_date, errors='coerce')
    if not pd.isna(target_ts):
        horizon_end = max(horizon_end, pd.Timestamp(target_ts).normalize())
    return horizon_end


def drop_rows_after_cutoff(df, date_col, cutoff_date, label):
    if date_col not in df.columns:
        return df

    date_series = pd.to_datetime(df[date_col], errors='coerce').dt.normalize()
    valid_mask = date_series.notna()
    invalid_rows = int((~valid_mask).sum())
    if invalid_rows:
        print(f"[WARN] {label}: {invalid_rows} lignes ignorees car la date est invalide.")

    cleaned = df.loc[valid_mask].copy()
    cleaned[date_col] = date_series.loc[valid_mask]

    future_mask = cleaned[date_col] > cutoff_date
    future_rows = int(future_mask.sum())
    if future_rows:
        future_dates = (
            cleaned.loc[future_mask, date_col]
            .value_counts()
            .sort_index()
            .head(5)
        )
        future_dates_summary = ", ".join(
            f"{idx.date().isoformat()} ({int(count)})"
            for idx, count in future_dates.items()
        )
        print(
            f"[WARN] {label}: {future_rows} lignes futures > {cutoff_date.date().isoformat()} ignorees "
            f"({future_dates_summary})."
        )
        cleaned = cleaned.loc[~future_mask].copy()

    return cleaned.reset_index(drop=True)


def build_recency_weights(dates):
    date_series = pd.to_datetime(pd.Series(dates), errors='coerce')
    if date_series.empty:
        return np.array([])
    min_date = date_series.min()
    max_date = date_series.max()
    span_days = max((max_date - min_date).days, 1)
    normalized = (date_series - min_date).dt.days / span_days
    return (0.4 + 0.6 * normalized).to_numpy()


def blend_expected_quantity(prob_buy, ca_if_buy, qte_if_buy, price_if_buy, avg_price_hist):
    prob_buy = np.clip(np.asarray(prob_buy, dtype=float), 0, 1)
    ca_if_buy = np.maximum(1.0, np.asarray(ca_if_buy, dtype=float))
    qte_if_buy = np.maximum(1.0, np.asarray(qte_if_buy, dtype=float))
    price_if_buy = np.maximum(0.5, np.asarray(price_if_buy, dtype=float))
    avg_price_hist = np.asarray(avg_price_hist, dtype=float)

    expected_ca = ca_if_buy * prob_buy
    qte_from_model = qte_if_buy * prob_buy
    qte_from_price = expected_ca / price_if_buy

    valid_hist_price = np.where(np.isfinite(avg_price_hist) & (avg_price_hist > 0.5), avg_price_hist, price_if_buy)
    qte_from_hist = expected_ca / np.maximum(0.5, valid_hist_price)

    blended = (0.50 * qte_from_price) + (0.35 * qte_from_model) + (0.15 * qte_from_hist)
    return np.maximum(0, blended)


def compute_raw_filter_caps(df_raw):
    if df_raw.empty:
        return {'ca_cap': None, 'qte_cap': None}
    return {
        'ca_cap': df_raw['vente_nette'].quantile(0.99),
        'qte_cap': df_raw['qte_totale'].quantile(0.99)
    }


def apply_raw_filter_caps(df_raw, quantile_caps):
    if df_raw.empty:
        return df_raw
    ca_cap = quantile_caps.get('ca_cap')
    qte_cap = quantile_caps.get('qte_cap')
    filtered = df_raw
    if ca_cap is not None:
        filtered = filtered[filtered['vente_nette'] <= ca_cap]
    if qte_cap is not None:
        filtered = filtered[filtered['qte_totale'] <= qte_cap]
    return filtered.copy()


def normalize_base_dataset(df_base):
    working = df_base.copy()
    working['client_code'] = working['client_code'].astype(str).str.strip()
    working['region'] = working['region'].fillna('Inconnu').astype(str).str.strip()
    working['delegation'] = working['delegation'].fillna('Inconnue').astype(str).str.strip()
    working['routing_code'] = working['routing_code'].fillna('Inconnue').astype(str).str.strip()
    working['home_commercial'] = working['home_commercial'].fillna('Inconnu').astype(str).str.strip()
    working['potentiel'] = pd.to_numeric(working['potentiel'], errors='coerce').fillna(0)
    working['ca_jour'] = pd.to_numeric(working['ca_jour'], errors='coerce').fillna(0)
    working['qte_jour'] = pd.to_numeric(working['qte_jour'], errors='coerce').fillna(0)
    working['docs_jour'] = pd.to_numeric(working['docs_jour'], errors='coerce').fillna(0)
    working['line_items_jour'] = pd.to_numeric(working['line_items_jour'], errors='coerce').fillna(0)
    working['product_refs_jour'] = pd.to_numeric(working['product_refs_jour'], errors='coerce').fillna(0)
    working = working[(working['ca_jour'] > 0) & (working['qte_jour'] > 0)].copy()
    if not working.empty:
        working = (
            working.groupby(['client_code', 'date_doc'], as_index=False)
            .agg({
                'region': 'first',
                'delegation': 'first',
                'routing_code': 'first',
                'home_commercial': 'first',
                'potentiel': 'max',
                'ca_jour': 'sum',
                'qte_jour': 'sum',
                'docs_jour': 'sum',
                'line_items_jour': 'sum',
                'product_refs_jour': 'sum',
            })
        )
    return working.sort_values(['client_code', 'date_doc']).reset_index(drop=True)


def convert_base_dataset_to_raw(df_base, quantile_caps=None):
    df_raw = df_base.rename(columns={
        'date_doc': 'date',
        'ca_jour': 'vente_nette',
        'qte_jour': 'qte_totale'
    }).copy()
    df_raw['client_code'] = df_raw['client_code'].astype(str).str.strip()
    df_raw['region'] = df_raw['region'].fillna('Inconnu').astype(str).str.strip()
    df_raw['delegation'] = df_raw['delegation'].fillna('Inconnue').astype(str).str.strip()
    df_raw['routing_code'] = df_raw['routing_code'].fillna('Inconnue').astype(str).str.strip()
    df_raw['home_commercial'] = df_raw['home_commercial'].fillna('Inconnu').astype(str).str.strip()
    df_raw['potentiel'] = pd.to_numeric(df_raw['potentiel'], errors='coerce').fillna(0)
    df_raw['vente_nette'] = pd.to_numeric(df_raw['vente_nette'], errors='coerce').fillna(0)
    df_raw['qte_totale'] = pd.to_numeric(df_raw['qte_totale'], errors='coerce').fillna(0)
    df_raw['docs_jour'] = pd.to_numeric(df_raw['docs_jour'], errors='coerce').fillna(0)
    df_raw['line_items_jour'] = pd.to_numeric(df_raw['line_items_jour'], errors='coerce').fillna(0)
    df_raw['product_refs_jour'] = pd.to_numeric(df_raw['product_refs_jour'], errors='coerce').fillna(0)
    df_raw = df_raw[(df_raw['vente_nette'] > 0) & (df_raw['qte_totale'] > 0)].copy()
    if df_raw.empty:
        return df_raw
    quantile_caps = quantile_caps or compute_raw_filter_caps(df_raw)
    return apply_raw_filter_caps(df_raw, quantile_caps)


def build_feature_panel_from_raw(df_raw, calendar_dates=None, default_values=None):
    if df_raw.empty:
        return pd.DataFrame()
    df_panel = build_dense_training_panel(df_raw, calendar_dates=calendar_dates)
    df_ml = df_panel.groupby('client_code', group_keys=False).apply(enrich_panel_features).reset_index(drop=True)
    return fill_feature_defaults(df_ml, default_values=default_values)


def build_feature_panel_from_base(df_base, calendar_dates=None, quantile_caps=None, default_values=None):
    normalized_base = normalize_base_dataset(df_base)
    if normalized_base.empty:
        return pd.DataFrame()
    df_raw = convert_base_dataset_to_raw(normalized_base, quantile_caps=quantile_caps)
    return build_feature_panel_from_raw(df_raw, calendar_dates=calendar_dates, default_values=default_values)


def build_daily_demand_history(df_features):
    if df_features.empty:
        return pd.DataFrame(columns=['date_doc', 'jour_semaine', 'total_ca', 'total_qte', 'buyers', 'active_clients'])
    daily = (
        df_features.groupby('date', as_index=False)
        .agg(
            total_ca=('vente_nette', 'sum'),
            total_qte=('qte_totale', 'sum'),
            buyers=('achat_target', 'sum'),
            active_clients=('client_code', 'nunique')
        )
        .rename(columns={'date': 'date_doc'})
    )
    daily['jour_semaine'] = ((daily['date_doc'].dt.weekday + 1) % 7).astype(int)
    return daily.sort_values('date_doc').reset_index(drop=True)


def build_preferences_frame(engine, cutoff_date):
    return pd.read_sql(text(get_preferences_query(cutoff_date)), engine)


def load_base_dataset(engine, cutoff_date=None, client_codes: Optional[Sequence[str]] = None):
    cutoff_date = pd.Timestamp(cutoff_date or resolve_data_cutoff_date()).normalize()
    base_query = get_base_dataset_query()
    params = {}
    normalized_codes = _normalize_client_codes(client_codes)

    if normalized_codes:
        base_query = f"""
            SELECT *
            FROM ({base_query}) source_rows
            WHERE source_rows.client_code IN :client_codes
        """
        sql = text(base_query).bindparams(bindparam('client_codes', expanding=True))
        params['client_codes'] = normalized_codes
    else:
        sql = text(base_query)

    df_base = pd.read_sql(sql, engine, params=params)
    return drop_rows_after_cutoff(df_base, 'date_doc', cutoff_date, 'dataset brut journalier')


def build_canonical_feature_bundle(
    engine,
    cutoff_date=None,
    client_codes: Optional[Sequence[str]] = None,
    calendar_end_date=None
):
    effective_cutoff = pd.Timestamp(cutoff_date or resolve_data_cutoff_date()).normalize()
    full_base = load_base_dataset(engine, effective_cutoff, client_codes=None)
    normalized_full = normalize_base_dataset(full_base)
    if normalized_full.empty:
        return {
            'cutoff_date': effective_cutoff,
            'base_rows': normalized_full,
            'raw_rows': pd.DataFrame(),
            'features': pd.DataFrame(),
            'daily_demand_history': pd.DataFrame(),
            'preferences': pd.DataFrame(columns=['client_code', 'produit_nom', 'produit_code', 'qte_moyenne'])
        }

    full_raw = convert_base_dataset_to_raw(normalized_full)
    quantile_caps = compute_raw_filter_caps(full_raw)
    horizon_end = pd.Timestamp(calendar_end_date or effective_cutoff).normalize()
    if horizon_end < effective_cutoff:
        horizon_end = effective_cutoff
    calendar_dates = list(pd.date_range(full_raw['date'].min(), horizon_end, freq='D'))
    full_panel = build_dense_training_panel(full_raw, calendar_dates=calendar_dates)
    full_feature_frame = full_panel.groupby('client_code', group_keys=False).apply(enrich_panel_features).reset_index(drop=True)
    default_values = compute_feature_default_values(full_feature_frame)
    full_features = fill_feature_defaults(full_feature_frame.copy(), default_values=default_values)

    normalized_codes = _normalize_client_codes(client_codes)
    if normalized_codes:
        normalized_base = normalized_full[normalized_full['client_code'].isin(normalized_codes)].copy()
    else:
        normalized_base = normalized_full.copy()

    df_raw = convert_base_dataset_to_raw(normalized_base, quantile_caps=quantile_caps)
    if normalized_codes:
        df_features = build_feature_panel_from_raw(
            df_raw,
            calendar_dates=calendar_dates,
            default_values=default_values,
        )
    else:
        df_features = full_features
    daily_demand_history = build_daily_demand_history(df_features)
    preferences = build_preferences_frame(engine, effective_cutoff)
    if 'client_code' in preferences.columns:
        preferences['client_code'] = preferences['client_code'].astype(str).str.strip()
    if normalized_codes:
        preferences = preferences[preferences['client_code'].isin(normalized_codes)].copy()
    if 'qte_moyenne' in preferences.columns:
        preferences['qte_moyenne'] = pd.to_numeric(preferences['qte_moyenne'], errors='coerce').fillna(1)

    return {
        'cutoff_date': effective_cutoff,
        'base_rows': normalized_base,
        'raw_rows': df_raw,
        'features': df_features,
        'daily_demand_history': daily_demand_history,
        'preferences': preferences
    }
