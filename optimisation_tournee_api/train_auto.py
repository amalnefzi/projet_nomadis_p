import os
import warnings

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, mean_absolute_percentage_error, r2_score, roc_auc_score
from sqlalchemy import create_engine
from xgboost import XGBClassifier, XGBRegressor

warnings.filterwarnings('ignore')


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
                    THEN STR_TO_DATE(e.date, '%%Y-%%m-%%d %%H:%%i:%%s')
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
                    THEN STR_TO_DATE(e.date, '%%Y-%%m-%%d %%H:%%i:%%s')
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
                    THEN DATE(STR_TO_DATE(e.date, '%%Y-%%m-%%d %%H:%%i:%%s'))
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


def build_dense_training_panel(df_base):
    calendar = pd.DataFrame({'date': sorted(df_base['date'].dropna().unique())})
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


def fill_feature_defaults(df):
    positive_sales = df.loc[df['vente_nette'] > 0, 'vente_nette']
    positive_qte = df.loc[df['qte_totale'] > 0, 'qte_totale']
    positive_docs = df.loc[df['docs_jour'] > 0, 'docs_jour']
    positive_line_items = df.loc[df['line_items_jour'] > 0, 'line_items_jour']
    positive_product_refs = df.loc[df['product_refs_jour'] > 0, 'product_refs_jour']
    price_series = df['vente_nette'] / df['qte_totale'].replace(0, np.nan)
    numeric_defaults = {
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


def quality_from_predictions(y_true, y_pred):
    r2 = r2_score(y_true, y_pred)
    try:
        mape = mean_absolute_percentage_error(y_true, y_pred)
        quality = round(100 / (1 + mape), 1)
        return quality, r2, round(mape * 100, 1)
    except Exception:
        quality = round(max(0, min(100, r2 * 100)), 1)
        return quality, r2, None


def quality_from_classifier(y_true, y_prob):
    if len(np.unique(y_true)) < 2:
        return 0.0, None, 0.0
    auc = roc_auc_score(y_true, y_prob)
    y_label = (y_prob >= 0.5).astype(int)
    accuracy = accuracy_score(y_true, y_label)
    return round(auc * 100, 1), round(auc, 4), round(accuracy * 100, 1)


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


print("Connexion a la base de donnees MySQL...")
engine = create_engine(get_mysql_url())
data_cutoff_date = resolve_data_cutoff_date()
print(f"[INFO] Date plafond d'entrainement: {data_cutoff_date.date().isoformat()}")

print("Extraction du dataset brut nettoye (client + jour)...")
df_base = pd.read_sql(get_base_dataset_query(), engine)

df_base = drop_rows_after_cutoff(df_base, 'date_doc', data_cutoff_date, 'dataset brut journalier')
df_base['client_code'] = df_base['client_code'].astype(str).str.strip()
df_base['region'] = df_base['region'].fillna('Inconnu').astype(str).str.strip()
df_base['delegation'] = df_base['delegation'].fillna('Inconnue').astype(str).str.strip()
df_base['routing_code'] = df_base['routing_code'].fillna('Inconnue').astype(str).str.strip()
df_base['home_commercial'] = df_base['home_commercial'].fillna('Inconnu').astype(str).str.strip()
df_base['potentiel'] = pd.to_numeric(df_base['potentiel'], errors='coerce').fillna(0)
df_base['ca_jour'] = pd.to_numeric(df_base['ca_jour'], errors='coerce').fillna(0)
df_base['qte_jour'] = pd.to_numeric(df_base['qte_jour'], errors='coerce').fillna(0)
df_base['docs_jour'] = pd.to_numeric(df_base['docs_jour'], errors='coerce').fillna(0)
df_base['line_items_jour'] = pd.to_numeric(df_base['line_items_jour'], errors='coerce').fillna(0)
df_base['product_refs_jour'] = pd.to_numeric(df_base['product_refs_jour'], errors='coerce').fillna(0)
df_base = df_base[(df_base['ca_jour'] > 0) & (df_base['qte_jour'] > 0)].copy()

if df_base.empty:
    raise RuntimeError("Aucune vente journaliere exploitable trouvee pour construire le dataset brut.")

df_base = df_base.sort_values(['client_code', 'date_doc']).reset_index(drop=True)
print(
    f"[OK] dataset brut journalier prepare avec {len(df_base)} lignes "
    f"et {df_base['client_code'].nunique()} clients."
)

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
    raise RuntimeError("Aucune vente exploitable trouvee pour entrainer l'IA.")

ca_cap = df_raw['vente_nette'].quantile(0.99)
qte_cap = df_raw['qte_totale'].quantile(0.99)
df_raw = df_raw[(df_raw['vente_nette'] <= ca_cap) & (df_raw['qte_totale'] <= qte_cap)].copy()

if df_raw.empty:
    raise RuntimeError("Le dataset d'entrainement est vide apres filtrage.")

print(
    f"[OK] {len(df_raw)} documents conserves "
    f"(CA max {df_raw['vente_nette'].max():.2f}, QTE max {df_raw['qte_totale'].max():.0f})"
)

print("Construction du panel client x date pour le modele Achat...")
df_panel = build_dense_training_panel(df_raw)

print("Construction des features derivees depuis l'historique existant...")
df_ml = df_panel.groupby('client_code', group_keys=False).apply(enrich_panel_features).reset_index(drop=True)
df_ml = fill_feature_defaults(df_ml)
df_ml.rename(columns={'date': 'date_doc', 'vente_nette': 'ca_jour', 'qte_totale': 'qte_jour'}).to_csv(
    'dataset_features_clients_jour.csv',
    index=False
)
print("[OK] dataset_features_clients_jour.csv cree.")

daily_demand_history = (
    df_ml.groupby('date', as_index=False)
    .agg(
        total_ca=('vente_nette', 'sum'),
        total_qte=('qte_totale', 'sum'),
        buyers=('achat_target', 'sum'),
        active_clients=('client_code', 'nunique')
    )
    .rename(columns={'date': 'date_doc'})
)
daily_demand_history['jour_semaine'] = ((daily_demand_history['date_doc'].dt.weekday + 1) % 7).astype(int)
daily_demand_history.to_csv('daily_demand_history.csv', index=False)
print("[OK] daily_demand_history.csv cree.")

feature_frame = build_feature_frame(df_ml)
saved_columns = list(feature_frame.columns)
joblib.dump(saved_columns, 'colonnes_ia.pkl')

df_model = pd.concat([
    df_ml[['client_code', 'date', 'vente_nette', 'qte_totale', 'achat_target']].reset_index(drop=True),
    feature_frame.reset_index(drop=True)
], axis=1)
df_model = df_model.loc[:, ~df_model.columns.duplicated()].copy()

split_index = max(1, int(len(df_model) * 0.8))
df_model = df_model.sort_values('date').reset_index(drop=True)
train_df = df_model.iloc[:split_index].copy()
test_df = df_model.iloc[split_index:].copy()

X_train = train_df[saved_columns].loc[:, ~train_df[saved_columns].columns.duplicated()].copy()
X_test = test_df[saved_columns].loc[:, ~test_df[saved_columns].columns.duplicated()].copy()
y_achat_train = train_df['achat_target']
y_achat_test = test_df['achat_target']
y_achat_train = y_achat_train.astype(int)
y_achat_test = y_achat_test.astype(int)
achat_positive_count = int(y_achat_train.sum())
achat_negative_count = int(len(y_achat_train) - achat_positive_count)
train_positive = train_df[train_df['achat_target'] == 1].copy()
test_positive = test_df[test_df['achat_target'] == 1].copy()

X_train_pos = train_positive[saved_columns].loc[:, ~train_positive[saved_columns].columns.duplicated()].copy()
X_test_pos = test_positive[saved_columns].loc[:, ~test_positive[saved_columns].columns.duplicated()].copy()
y_ca_train = train_positive['vente_nette']
y_ca_test = test_positive['vente_nette']
y_qte_train = train_positive['qte_totale']
y_qte_test = test_positive['qte_totale']
y_price_train = (train_positive['vente_nette'] / train_positive['qte_totale'].replace(0, np.nan)).fillna(0.5).clip(lower=0.5)
y_price_test = (test_positive['vente_nette'] / test_positive['qte_totale'].replace(0, np.nan)).fillna(0.5).clip(lower=0.5)
achat_train_weights = build_recency_weights(train_df['date'])
ca_train_weights = build_recency_weights(train_positive['date'])
qte_train_weights = build_recency_weights(train_positive['date'])
price_train_weights = build_recency_weights(train_positive['date'])

common_params = {
    'n_estimators': 350,
    'learning_rate': 0.05,
    'max_depth': 5,
    'subsample': 0.85,
    'colsample_bytree': 0.85,
    'min_child_weight': 2,
    'objective': 'reg:squarederror',
    'random_state': 42,
    'verbosity': 0
}

print("Entrainement du modele XGBoost Achat...")
print(
    f"[INFO] ACHAT train imbalance -> positives: {achat_positive_count} | "
    f"negatives: {achat_negative_count}"
)
model_achat = XGBClassifier(
    n_estimators=300,
    learning_rate=0.05,
    max_depth=5,
    subsample=0.85,
    colsample_bytree=0.85,
    min_child_weight=2,
    objective='binary:logistic',
    eval_metric='logloss',
    random_state=42,
    verbosity=0
)
model_achat.fit(X_train, y_achat_train, sample_weight=achat_train_weights)

print("Entrainement du modele XGBoost CA...")
model_ca = XGBRegressor(**common_params)
model_ca.fit(X_train_pos, np.log1p(y_ca_train), sample_weight=ca_train_weights)

print("Entrainement du modele XGBoost Quantite...")
model_qte = XGBRegressor(**common_params)
model_qte.fit(X_train_pos, np.log1p(y_qte_train), sample_weight=qte_train_weights)

print("Entrainement du modele XGBoost Prix unitaire...")
model_price = XGBRegressor(**common_params)
model_price.fit(X_train_pos, np.log1p(y_price_train), sample_weight=price_train_weights)

pred_achat = model_achat.predict_proba(X_test)[:, 1]
pred_ca = np.maximum(1, np.expm1(model_ca.predict(X_test_pos)))
pred_qte = np.maximum(1, np.expm1(model_qte.predict(X_test_pos)))
pred_price = np.maximum(0.5, np.expm1(model_price.predict(X_test_pos)))
pred_achat_pos = model_achat.predict_proba(X_test_pos)[:, 1]
hybrid_qte = blend_expected_quantity(
    pred_achat_pos,
    pred_ca,
    pred_qte,
    pred_price,
    test_positive['avg_price_hist'].to_numpy()
)

quality_achat, auc_achat, acc_achat = quality_from_classifier(y_achat_test, pred_achat)
quality_ca, r2_ca, mape_ca = quality_from_predictions(y_ca_test, pred_ca)
quality_qte_model, r2_qte_model, mape_qte_model = quality_from_predictions(y_qte_test, pred_qte)
quality_qte, r2_qte, mape_qte = quality_from_predictions(y_qte_test, hybrid_qte)
quality_price, r2_price, mape_price = quality_from_predictions(y_price_test, pred_price)
quality_score = round((quality_achat + quality_ca + quality_qte) / 3, 1)

print(f"[INFO] ACHAT -> AUC: {auc_achat if auc_achat is not None else 'n/a'} | Accuracy: {acc_achat}% | Score: {quality_achat}%")
print(f"[INFO] CA  -> R2: {r2_ca:.4f} | MAPE: {mape_ca if mape_ca is not None else 'n/a'}% | Score: {quality_ca}%")
print(f"[INFO] PRICE -> R2: {r2_price:.4f} | MAPE: {mape_price if mape_price is not None else 'n/a'}% | Score: {quality_price}%")
print(f"[INFO] QTE modele -> R2: {r2_qte_model:.4f} | MAPE: {mape_qte_model if mape_qte_model is not None else 'n/a'}% | Score: {quality_qte_model}%")
print(f"[INFO] QTE hybride -> R2: {r2_qte:.4f} | MAPE: {mape_qte if mape_qte is not None else 'n/a'}% | Score: {quality_qte}%")

joblib.dump(model_achat, 'modele_nomadis_achat.pkl')
joblib.dump(model_ca, 'modele_nomadis_ca.pkl')
joblib.dump(model_qte, 'modele_nomadis_qte.pkl')
joblib.dump(model_price, 'modele_nomadis_price.pkl')

print("Preparation du modele XGBoost d'affectation commerciale...")
df_assignment_docs = pd.read_sql(get_assignment_dataset_query(), engine)
df_assignment_docs = drop_rows_after_cutoff(
    df_assignment_docs,
    'date_doc',
    data_cutoff_date,
    'dataset affectation commerciale'
)
df_assignment_docs['client_code'] = df_assignment_docs['client_code'].astype(str).str.strip()
df_assignment_docs['commercial_code'] = df_assignment_docs['commercial_code'].fillna('Inconnu').astype(str).str.strip()
df_assignment_docs = df_assignment_docs[df_assignment_docs['commercial_code'] != 'Inconnu'].copy()
df_assignment_docs = df_assignment_docs.rename(columns={'date_doc': 'date'})

df_assignment_train = df_ml.merge(
    df_assignment_docs[['client_code', 'date', 'commercial_code']],
    on=['client_code', 'date'],
    how='inner'
).copy()
df_assignment_train = df_assignment_train[df_assignment_train['commercial_code'].notna()].copy()
df_assignment_train['commercial_code'] = df_assignment_train['commercial_code'].astype(str).str.strip()
df_assignment_train = df_assignment_train[df_assignment_train['commercial_code'] != ''].copy()

if df_assignment_train['commercial_code'].nunique() >= 2:
    assignment_feature_frame = build_assignment_feature_frame(df_assignment_train)
    assignment_columns = list(assignment_feature_frame.columns)

    df_assignment_model = pd.concat([
        df_assignment_train[['date', 'commercial_code']].reset_index(drop=True),
        assignment_feature_frame.reset_index(drop=True)
    ], axis=1)
    df_assignment_model = df_assignment_model.loc[:, ~df_assignment_model.columns.duplicated()].copy()
    df_assignment_model = df_assignment_model.sort_values('date').reset_index(drop=True)

    split_index_assignment = max(1, int(len(df_assignment_model) * 0.8))
    train_assignment_df = df_assignment_model.iloc[:split_index_assignment].copy()
    test_assignment_df = df_assignment_model.iloc[split_index_assignment:].copy()

    assignment_classes = sorted(train_assignment_df['commercial_code'].astype(str).str.strip().unique().tolist())
    if len(assignment_classes) < 2:
        print("[INFO] AFFECTATION -> ignoree, moins de deux commerciaux dans la fenetre d'entrainement.")
    else:
        assignment_label_to_id = {label: idx for idx, label in enumerate(assignment_classes)}
        unseen_test_mask = ~test_assignment_df['commercial_code'].astype(str).str.strip().isin(assignment_classes)
        unseen_test_rows = int(unseen_test_mask.sum())
        if unseen_test_rows:
            print(
                f"[WARN] AFFECTATION -> {unseen_test_rows} lignes de test ignorees "
                "car leur commercial n'existe pas encore dans le train."
            )
            test_assignment_df = test_assignment_df.loc[~unseen_test_mask].copy()

        joblib.dump(assignment_columns, 'colonnes_affectation.pkl')
        joblib.dump(assignment_classes, 'classes_affectation.pkl')

        X_assignment_train = train_assignment_df[assignment_columns].loc[:, ~train_assignment_df[assignment_columns].columns.duplicated()].copy()
        X_assignment_test = test_assignment_df[assignment_columns].loc[:, ~test_assignment_df[assignment_columns].columns.duplicated()].copy()
        y_assignment_train = train_assignment_df['commercial_code'].map(assignment_label_to_id).astype(int)
        y_assignment_test = test_assignment_df['commercial_code'].map(assignment_label_to_id).astype(int)
        assignment_train_weights = build_recency_weights(train_assignment_df['date'])

        model_affectation = XGBClassifier(
            n_estimators=260,
            learning_rate=0.05,
            max_depth=6,
            subsample=0.85,
            colsample_bytree=0.85,
            min_child_weight=2,
            objective='multi:softprob',
            eval_metric='mlogloss',
            num_class=len(assignment_classes),
            random_state=42,
            verbosity=0
        )
        model_affectation.fit(X_assignment_train, y_assignment_train, sample_weight=assignment_train_weights)
        joblib.dump(model_affectation, 'modele_nomadis_affectation.pkl')

        if not test_assignment_df.empty:
            pred_assignment = model_affectation.predict(X_assignment_test)
            assignment_accuracy = accuracy_score(y_assignment_test, pred_assignment)
            print(f"[INFO] AFFECTATION -> Accuracy: {round(assignment_accuracy * 100, 1)}% | Classes train: {len(assignment_classes)}")
        else:
            print(f"[INFO] AFFECTATION -> modele entraine avec {len(assignment_classes)} classes train, sans jeu de test exploitable.")
else:
    print("[INFO] AFFECTATION -> ignoree, moins de deux commerciaux exploitables.")

with open('precision.txt', 'w', encoding='utf8') as f:
    f.write(str(quality_score))

print("Preparation de la base de prediction par client et jour...")
candidate_cols = list(dict.fromkeys([
    'client_code',
    *MAIN_CATEGORICAL_COLUMNS,
    *FEATURE_COLUMNS_BASE,
    'date'
]))
df_candidates = df_ml[candidate_cols].sort_values('date')
# Snapshot legacy pour diagnostic/inspection rapide. Les predictions temps reel
# doivent reconstituer l'etat "as-of date" depuis dataset_features_clients_jour.csv.
df_candidates = df_candidates.groupby(['client_code', 'jour_semaine'], as_index=False).tail(1)
df_candidates.to_csv('master_dataset_v3.csv', index=False)

query_prefs = get_preferences_query(data_cutoff_date)
df_prefs = pd.read_sql(query_prefs, engine)
df_prefs['client_code'] = df_prefs['client_code'].astype(str).str.strip()
df_prefs['produit_nom'] = df_prefs['produit_nom'].fillna(df_prefs['produit_code']).astype(str).str.strip()
df_prefs['qte_moyenne'] = pd.to_numeric(df_prefs['qte_moyenne'], errors='coerce').fillna(1)
df_prefs.to_csv('preferences_clients_produits.csv', index=False)

print(f"SUCCES ! Trois modeles XGBoost re-entraines. Score global: {quality_score}%")
