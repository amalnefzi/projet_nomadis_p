import os
import warnings
import json

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score
from sqlalchemy import create_engine, text
from xgboost import XGBClassifier, XGBRegressor
from nomadis_feature_store import (
    build_feature_store_source_summary,
    ensure_feature_store_tables,
    persist_feature_store_snapshot,
)
from nomadis_feature_engineering import (
    ASSIGNMENT_CATEGORICAL_COLUMNS,
    FEATURE_COLUMNS_BASE,
    MAIN_CATEGORICAL_COLUMNS,
    blend_expected_quantity,
    build_canonical_feature_bundle,
    build_assignment_feature_frame,
    build_dense_training_panel,
    build_feature_frame,
    build_recency_weights,
    convert_base_dataset_to_raw,
    drop_rows_after_cutoff,
    enrich_panel_features,
    fill_feature_defaults,
    get_assignment_dataset_query,
    get_base_dataset_query,
    get_mysql_url,
    get_preferences_query,
    normalize_base_dataset,
    resolve_data_cutoff_date,
    resolve_serving_data_upper_bound_date,
)
from nomadis_model_strategy import (
    build_historical_baselines,
    choose_strategy,
    compute_classifier_metrics,
    compute_regression_metrics,
    save_strategy,
)

warnings.filterwarnings('ignore')


print("Connexion a la base de donnees MySQL...")
engine = create_engine(get_mysql_url())
data_cutoff_date = resolve_data_cutoff_date()
serving_cutoff_date = pd.Timestamp(resolve_serving_data_upper_bound_date()).normalize()
print(f"[INFO] Date plafond d'entrainement: {data_cutoff_date.date().isoformat()}")
print(f"[INFO] Date plafond de serving: {serving_cutoff_date.date().isoformat()}")

print("Extraction du dataset brut nettoye (client + jour)...")
df_base = pd.read_sql(text(get_base_dataset_query()), engine)
df_base = drop_rows_after_cutoff(df_base, 'date_doc', data_cutoff_date, 'dataset brut journalier')
df_base = normalize_base_dataset(df_base)

if df_base.empty:
    raise RuntimeError("Aucune vente journaliere exploitable trouvee pour construire le dataset brut.")

df_base = df_base.sort_values(['client_code', 'date_doc']).reset_index(drop=True)
print(
    f"[OK] dataset brut journalier prepare avec {len(df_base)} lignes "
    f"et {df_base['client_code'].nunique()} clients."
)

df_raw = convert_base_dataset_to_raw(df_base)

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
    verbosity=0,
    scale_pos_weight=achat_negative_count / achat_positive_count
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
test_positive_mask = test_df['achat_target'].to_numpy(dtype=int) == 1
test_baselines = build_historical_baselines(test_df)
test_positive_baselines = {
    target_name: values[test_positive_mask]
    for target_name, values in test_baselines.items()
}

pred_ca_all = np.maximum(0.0, np.expm1(model_ca.predict(X_test)))
pred_qte_all = np.maximum(0.0, np.expm1(model_qte.predict(X_test)))
pred_price_all = np.maximum(0.0, np.expm1(model_price.predict(X_test)))

pred_ca = pred_ca_all[test_positive_mask]
pred_qte = pred_qte_all[test_positive_mask]
pred_price = pred_price_all[test_positive_mask]

expected_ca_model_all = pred_achat * pred_ca_all
expected_ca_baseline_all = pred_achat * test_baselines['ca_if_buy']
expected_qte_model_all = blend_expected_quantity(
    pred_achat,
    pred_ca_all,
    pred_qte_all,
    pred_price_all,
    test_df['avg_price_hist'].to_numpy()
)
expected_qte_baseline_all = blend_expected_quantity(
    pred_achat,
    test_baselines['ca_if_buy'],
    test_baselines['qte_if_buy'],
    test_baselines['price_if_buy'],
    test_df['avg_price_hist'].to_numpy()
)

purchase_metrics = compute_classifier_metrics(y_achat_test, pred_achat)
ca_model_metrics = compute_regression_metrics(y_ca_test, pred_ca)
ca_baseline_metrics = compute_regression_metrics(y_ca_test, test_positive_baselines['ca_if_buy'])
qte_model_metrics = compute_regression_metrics(y_qte_test, pred_qte)
qte_baseline_metrics = compute_regression_metrics(y_qte_test, test_positive_baselines['qte_if_buy'])
price_model_metrics = compute_regression_metrics(y_price_test, pred_price)
price_baseline_metrics = compute_regression_metrics(y_price_test, test_positive_baselines['price_if_buy'])
expected_ca_model_metrics = compute_regression_metrics(test_df['vente_nette'], expected_ca_model_all)
expected_ca_baseline_metrics = compute_regression_metrics(test_df['vente_nette'], expected_ca_baseline_all)
expected_qte_model_metrics = compute_regression_metrics(test_df['qte_totale'], expected_qte_model_all)
expected_qte_baseline_metrics = compute_regression_metrics(test_df['qte_totale'], expected_qte_baseline_all)

ca_strategy = choose_strategy(ca_model_metrics, ca_baseline_metrics)
qte_strategy = choose_strategy(qte_model_metrics, qte_baseline_metrics)
price_strategy = choose_strategy(price_model_metrics, price_baseline_metrics)

selected_ca_if_buy_all = pred_ca_all if ca_strategy['selected'] == 'model' else test_baselines['ca_if_buy']
selected_qte_if_buy_all = pred_qte_all if qte_strategy['selected'] == 'model' else test_baselines['qte_if_buy']
selected_price_if_buy_all = pred_price_all if price_strategy['selected'] == 'model' else test_baselines['price_if_buy']

expected_ca_selected_all = pred_achat * selected_ca_if_buy_all
expected_qte_selected_all = blend_expected_quantity(
    pred_achat,
    selected_ca_if_buy_all,
    selected_qte_if_buy_all,
    selected_price_if_buy_all,
    test_df['avg_price_hist'].to_numpy()
)

expected_ca_selected_metrics = compute_regression_metrics(test_df['vente_nette'], expected_ca_selected_all)
expected_qte_selected_metrics = compute_regression_metrics(test_df['qte_totale'], expected_qte_selected_all)

strategy_payload = {
    "strategy_version": 1,
    "generated_at": pd.Timestamp.utcnow().isoformat() + "Z",
    "selection_metric": ca_strategy["selection_metric"],
    "purchase": {
        "metrics": purchase_metrics,
    },
    "targets": {
        "ca_if_buy": {
            **ca_strategy,
            "baseline_name": "historical_avg_ca_per_order_90d_fallback_vente_avg_3_then_vente_last",
            "model_metrics": ca_model_metrics,
            "baseline_metrics": ca_baseline_metrics,
        },
        "qte_if_buy": {
            **qte_strategy,
            "baseline_name": "historical_avg_qte_per_order_90d_fallback_qte_avg_3_then_qte_last",
            "model_metrics": qte_model_metrics,
            "baseline_metrics": qte_baseline_metrics,
        },
        "price_if_buy": {
            **price_strategy,
            "baseline_name": "historical_avg_price_hist_fallback_ca_over_qte",
            "model_metrics": price_model_metrics,
            "baseline_metrics": price_baseline_metrics,
        },
    },
    "expected": {
        "ca_all_days": {
            "model_metrics": expected_ca_model_metrics,
            "baseline_metrics": expected_ca_baseline_metrics,
            "selected_metrics": expected_ca_selected_metrics,
        },
        "qte_all_days": {
            "model_metrics": expected_qte_model_metrics,
            "baseline_metrics": expected_qte_baseline_metrics,
            "selected_metrics": expected_qte_selected_metrics,
        },
    },
}

print(
    f"[INFO] ACHAT -> AUC: {purchase_metrics['auc'] if purchase_metrics['auc'] is not None else 'n/a'} "
    f"| Accuracy: {purchase_metrics['accuracy'] if purchase_metrics['accuracy'] is not None else 'n/a'}%"
)
print(
    f"[INFO] CA conditionnel modele -> R2: {ca_model_metrics['r2']} | "
    f"MAE: {ca_model_metrics['mae']} | MAPE: {ca_model_metrics['mape'] if ca_model_metrics['mape'] is not None else 'n/a'}%"
)
print(
    f"[INFO] CA conditionnel baseline -> R2: {ca_baseline_metrics['r2']} | "
    f"MAE: {ca_baseline_metrics['mae']} | MAPE: {ca_baseline_metrics['mape'] if ca_baseline_metrics['mape'] is not None else 'n/a'}% "
    f"| Serving: {ca_strategy['selected']}"
)
print(
    f"[INFO] QTE conditionnelle modele -> R2: {qte_model_metrics['r2']} | "
    f"MAE: {qte_model_metrics['mae']} | MAPE: {qte_model_metrics['mape'] if qte_model_metrics['mape'] is not None else 'n/a'}%"
)
print(
    f"[INFO] QTE conditionnelle baseline -> R2: {qte_baseline_metrics['r2']} | "
    f"MAE: {qte_baseline_metrics['mae']} | MAPE: {qte_baseline_metrics['mape'] if qte_baseline_metrics['mape'] is not None else 'n/a'}% "
    f"| Serving: {qte_strategy['selected']}"
)
print(
    f"[INFO] PRIX conditionnel modele -> R2: {price_model_metrics['r2']} | "
    f"MAE: {price_model_metrics['mae']} | MAPE: {price_model_metrics['mape'] if price_model_metrics['mape'] is not None else 'n/a'}%"
)
print(
    f"[INFO] PRIX conditionnel baseline -> R2: {price_baseline_metrics['r2']} | "
    f"MAE: {price_baseline_metrics['mae']} | MAPE: {price_baseline_metrics['mape'] if price_baseline_metrics['mape'] is not None else 'n/a'}% "
    f"| Serving: {price_strategy['selected']}"
)
print(
    f"[INFO] CA attendu tous jours -> modele R2: {expected_ca_model_metrics['r2']} | MAE: {expected_ca_model_metrics['mae']} "
    f"|| baseline R2: {expected_ca_baseline_metrics['r2']} | MAE: {expected_ca_baseline_metrics['mae']} "
    f"|| serving R2: {expected_ca_selected_metrics['r2']} | MAE: {expected_ca_selected_metrics['mae']}"
)
print(
    f"[INFO] QTE attendue tous jours -> modele R2: {expected_qte_model_metrics['r2']} | MAE: {expected_qte_model_metrics['mae']} "
    f"|| baseline R2: {expected_qte_baseline_metrics['r2']} | MAE: {expected_qte_baseline_metrics['mae']} "
    f"|| serving R2: {expected_qte_selected_metrics['r2']} | MAE: {expected_qte_selected_metrics['mae']}"
)

joblib.dump(model_achat, 'modele_nomadis_achat.pkl')
joblib.dump(model_ca, 'modele_nomadis_ca.pkl')
joblib.dump(model_qte, 'modele_nomadis_qte.pkl')
joblib.dump(model_price, 'modele_nomadis_price.pkl')

print("Preparation du modele XGBoost d'affectation commerciale...")
df_assignment_docs = pd.read_sql(text(get_assignment_dataset_query()), engine)
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

save_strategy('.', strategy_payload)
purchase_auc = strategy_payload.get('purchase', {}).get('metrics', {}).get('auc')
precision_value = round(float(purchase_auc) * 100.0, 1) if purchase_auc is not None else 0.0
with open('precision.txt', 'w', encoding='utf8') as f:
    f.write(str(precision_value))

print("Synchronisation du feature store canonique...")
ensure_feature_store_tables(engine)
serving_bundle = build_canonical_feature_bundle(engine, cutoff_date=serving_cutoff_date)
serving_source_summary = build_feature_store_source_summary(
    engine,
    reference_now=serving_cutoff_date + pd.Timedelta(days=1)
)
persisted_feature_store = persist_feature_store_snapshot(
    engine,
    serving_bundle,
    serving_source_summary,
    reason='manual_full_retrain'
)
print(
    "[OK] feature store canonique synchronise "
    f"(version={persisted_feature_store['feature_state_version']}, "
    f"clients={persisted_feature_store['client_count']}, "
    f"cutoff={serving_source_summary.get('source_max_date') or serving_cutoff_date.date().isoformat()})."
)

print("Preparation de la base de prediction par client et jour...")
candidate_cols = list(dict.fromkeys([
    'client_code',
    *MAIN_CATEGORICAL_COLUMNS,
    *FEATURE_COLUMNS_BASE,
    'date'
]))
df_candidates = df_ml[candidate_cols].sort_values('date')
# Snapshot legacy pour audit/export. Le serving temps reel utilise
# desormais le feature store canonique ; ce CSV reste un artefact
# reproductible pour debug et entrainement manuel.
df_candidates = df_candidates.groupby(['client_code', 'jour_semaine'], as_index=False).tail(1)
df_candidates.to_csv('master_dataset_v3.csv', index=False)

query_prefs = get_preferences_query(data_cutoff_date)
df_prefs = pd.read_sql(text(query_prefs), engine)
df_prefs['client_code'] = df_prefs['client_code'].astype(str).str.strip()
df_prefs['produit_nom'] = df_prefs['produit_nom'].fillna(df_prefs['produit_code']).astype(str).str.strip()
df_prefs['qte_moyenne'] = pd.to_numeric(df_prefs['qte_moyenne'], errors='coerce').fillna(1)
df_prefs.to_csv('preferences_clients_produits.csv', index=False)

print("SUCCES ! Modeles IA re-entraines, evaluation chronologique explicite et strategie Dashboard persistee.")
