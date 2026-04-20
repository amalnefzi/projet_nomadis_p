from flask import Flask, request, jsonify
import pandas as pd
import joblib
import numpy as np
import sys

app = Flask(__name__)

FEATURE_COLUMNS_BASE = [
    'jour_semaine',
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

model_achat = None
model_ca = None
model_qte = None
model_price = None
feature_columns = []
df_master = pd.DataFrame()
df_prefs = pd.DataFrame(columns=['client_code', 'produit_nom', 'produit_code', 'qte_moyenne'])

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(errors="replace")


def build_features(df):
    features = df[FEATURE_COLUMNS_BASE + ['region']].copy()
    features['region'] = features['region'].fillna('Inconnu').astype(str).str.strip()
    for col in FEATURE_COLUMNS_BASE:
        features[col] = pd.to_numeric(features[col], errors='coerce').fillna(0)
    features = pd.get_dummies(features, columns=['region'], dummy_na=False)
    if feature_columns:
        features = features.reindex(columns=feature_columns, fill_value=0)
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


print("Chargement des trois modeles XGBoost et des donnees...")
try:
    model_achat = joblib.load('modele_nomadis_achat.pkl')
    model_ca = joblib.load('modele_nomadis_ca.pkl')
    model_qte = joblib.load('modele_nomadis_qte.pkl')
    model_price = joblib.load('modele_nomadis_price.pkl')
    feature_columns = joblib.load('colonnes_ia.pkl')
    df_master = pd.read_csv('master_dataset_v3.csv')
    df_master['client_code'] = df_master['client_code'].astype(str).str.strip()
    df_master['region'] = df_master['region'].fillna('Inconnu').astype(str).str.strip()
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

    print("IA prete avec les modeles XGBoost Achat + CA + Quantite.")
except Exception as e:
    print(f"Erreur de chargement : {e}")


@app.route('/api/predict', methods=['POST'])
def predict_tournee():
    try:
        if model_achat is None or model_ca is None or model_qte is None or model_price is None or not feature_columns or df_master.empty:
            return jsonify({
                "status": "error",
                "message": "Modeles IA non charges. Lancez train_auto.py pour regenerer les artefacts XGBoost."
            }), 503

        data = request.json or {}
        date_str = data.get('date', '2026-03-15')
        target_date = pd.to_datetime(date_str)
        # MySQL DAYOFWEEK()-1 scale: Sunday=0, Monday=1, ..., Saturday=6
        jour_semaine = (target_date.weekday() + 1) % 7
        month = target_date.month

        print(f"Prediction demandee pour le jour : {jour_semaine} (Date: {date_str})")

        clients_du_jour = df_master[df_master['jour_semaine'] == jour_semaine].copy()
        clients_du_jour = clients_du_jour.drop_duplicates(subset=['client_code'])
        clients_du_jour['month'] = month

        if clients_du_jour.empty:
            return jsonify({"status": "error", "message": "Pas d'historique pour ce jour."})

        X_pred = build_features(clients_du_jour)
        achat_prob = np.clip(model_achat.predict_proba(X_pred)[:, 1], 0, 1)
        pred_ca_if_buy = np.maximum(1, np.expm1(model_ca.predict(X_pred)))
        pred_qte_if_buy = np.maximum(1, np.expm1(model_qte.predict(X_pred)))
        pred_price_if_buy = np.maximum(0.5, np.expm1(model_price.predict(X_pred)))

        clients_du_jour['Prob_achat'] = np.round(achat_prob * 100, 1)
        clients_du_jour['Pred_ca_if_buy'] = pred_ca_if_buy
        clients_du_jour['Pred_qte_if_buy'] = pred_qte_if_buy
        clients_du_jour['Prix_pred'] = pred_price_if_buy
        clients_du_jour['Vn_predit'] = clients_du_jour['Pred_ca_if_buy'] * achat_prob
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
        clients_du_jour['Habit_score'] = clients_du_jour.apply(compute_habit_score, axis=1)
        clients_du_jour['Recency_score'] = clients_du_jour.apply(compute_recency_score, axis=1)
        fallback_mask = ~np.isfinite(clients_du_jour['Prob_achat'])
        if fallback_mask.any():
            clients_du_jour.loc[fallback_mask, 'Prob_achat'] = clients_du_jour.loc[fallback_mask].apply(build_purchase_probability, axis=1)

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

        result_dict = {}
        for _, row in clients_du_jour.iterrows():
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

            details_qte, total_qte = rebalance_quantities(row['Qte_predite'], product_weights)
            prix_moyen = float(row['Vn_predit']) / max(1, total_qte)

            result_dict[code_str] = {
                "score": round(row['Score'], 1),
                "confidence": round(row['Confidence'], 1),
                "vip": int(row['VIP']),
                "qte": int(total_qte),
                "chiffre": round(float(row['Vn_predit']), 2),
                "details": details_qte,
                "prix_moyen": round(prix_moyen, 2),
                "prob_achat": round(float(row['Prob_achat']), 1),
                "habit_score": round(float(row['Habit_score']), 1),
                "recency_score": round(float(row['Recency_score']), 1)
            }

        return jsonify({"status": "success", "predictions": result_dict})

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})


if __name__ == '__main__':
    app.run(port=5001, debug=True)
