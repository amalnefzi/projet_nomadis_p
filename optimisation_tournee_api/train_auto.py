import pandas as pd
import numpy as np
import joblib
from xgboost import XGBRegressor
from sqlalchemy import create_engine
from sklearn.model_selection import train_test_split  # <-- ZEDNA HEDHI
from sklearn.metrics import r2_score, mean_absolute_percentage_error  # <-- ZEDNA HEDHI
import warnings
warnings.filterwarnings('ignore')

print("Connexion a la base de donnees MySQL (dist_utic)...")
engine = create_engine('mysql+pymysql://root:@localhost/dist_utic')

print("Extraction de l'historique VRAI (Ventes + Produits)...")
query_ventes = """
    SELECT 
        LPAD(e.client_code, 5, '0') as client_code,
        c.region,
        c.potentiel,
        e.date,
        (DAYOFWEEK(e.date) - 1) as jour_semaine, 
        e.net_a_payer as vente_nette
    FROM entetecommercials e
    JOIN clients c ON e.client_code = c.code
    WHERE e.type IN ('facture', 'bl', 'blf') AND e.net_a_payer > 0
"""
df_raw = pd.read_sql(query_ventes, engine)
df_raw['date'] = pd.to_datetime(df_raw['date'], errors='coerce')
df_raw = df_raw.dropna(subset=['date'])

print("Preparation des donnees d'entrainement...")
df_ml = df_raw.groupby(['client_code', 'region', 'potentiel', 'jour_semaine']).agg(
    nbr_visites=('vente_nette', 'count'),
    vente_nette=('vente_nette', 'mean')
).reset_index()
df_ml = df_ml.fillna('Inconnu')
df_ml['client_code'] = df_ml['client_code'].astype(str).str.strip()

# 🔥 FILTRER LES VALEURS ABERRANTES 🔥
# Supprimer ventes nulles ou négatives
df_ml = df_ml[df_ml['vente_nette'] > 0].copy()

# Supprimer les outliers (top 1% des ventes très hautes)
seuil_haut = df_ml['vente_nette'].quantile(0.99)
df_ml = df_ml[df_ml['vente_nette'] <= seuil_haut].copy()

print(f"   ✅ Après filtrage: {len(df_ml)} lignes (ventes entre {df_ml['vente_nette'].min():.2f} et {df_ml['vente_nette'].max():.2f})")

print("Entrainement du modele en cours (ca peut prendre quelques secondes)...")
X_raw = df_ml.drop(columns=['vente_nette', 'client_code'])
y = df_ml['vente_nette']

# 🔥 NORMALISER Y POUR ÉVITER LES EXTRÊMES 🔥
# Utiliser log pour lisser les valeurs très différentes
y_log = np.log1p(y)  # log1p = log(1 + x)

X = pd.get_dummies(X_raw).astype(int)
joblib.dump(list(X.columns), 'colonnes_ia.pkl')

# 🔥 TRAIN/TEST SPLIT 🔥
X_train, X_test, y_train_log, y_test_log = train_test_split(X, y_log, test_size=0.20, random_state=42)

# Récupérer aussi y original pour MAPE
y_train = np.expm1(y_train_log)
y_test = np.expm1(y_test_log)

# 🔥 PARAMÈTRES XGBoost AMÉLIORÉS 🔥
model = XGBRegressor(
    n_estimators=500,        # Moins d'arbres (évite overfitting)
    learning_rate=0.05,      # Apprentissage plus lent = meilleur
    max_depth=5,             # Moins profond = moins complexe
    subsample=0.8,           # Utiliser 80% des données par arbre
    colsample_bytree=0.8,    # Utiliser 80% des features
    min_child_weight=2,      # Minimum 2 samples par leaf
    random_state=42,
    verbosity=0
)

# Entraîner SUR LES DONNÉES NORMALISÉES (log)
model.fit(X_train, y_train_log)

# 🔥 CALCUL DU TAUX DE CONFIANCE - SUR DONNÉES ORIGINALES 🔥
y_pred_log = model.predict(X_test)
y_pred = np.expm1(y_pred_log)  # Reconvertir en original

# 🔥 CALCUL DU TAUX DE CONFIANCE (ACCURACY) - CORRECTED 🔥
# Utiliser R² Score (meilleure métrique pour la régression)
# R² = 1 - (SS_res / SS_tot)
# Valeur entre 0 et 1 (ou négative si très mauvais)

r2 = r2_score(y_test, y_pred)

# Convertir R² en pourcentage (0-100%)
# Si R² = 0.85 → 85% de confiance
confiance_pourcentage = round(max(0, min(100, r2 * 100)), 1)

# MAPE pour voir l'écart moyen en %
try:
    mape = mean_absolute_percentage_error(y_test, y_pred)
    mape_pct = round(mape * 100, 1)
    print(f"📊 R² Score: {r2:.4f}")
    print(f"📊 MAPE (Erreur %): {mape_pct}%")
except:
    mape_pct = 0

print(f"✅ TAUX DE CONFIANCE (ACCURACY) : {confiance_pourcentage} %")

# 🔥 SAUVEGARDE DU VRAI SCORE POUR LE REACT 🔥
with open('precision.txt', 'w') as f:
    f.write(str(confiance_pourcentage))

joblib.dump(model, 'modele_nomadis.pkl')

print("Creation du profil d'achat de chaque client...")
df_ml.to_csv('master_dataset_v3.csv', index=False)

query_prefs = """
    SELECT 
        LPAD(e.client_code, 5, '0') as client_code,
        p.code as produit_code,
        p.libelle as produit_nom,
        AVG(l.quantite) as qte_moyenne
    FROM lignecommercials l
    JOIN entetecommercials e ON l.entetecommercial_code = e.code
    JOIN produits p ON l.produit_code = p.code
    WHERE e.type IN ('facture', 'bl', 'blf')
    GROUP BY e.client_code, p.code, p.libelle
"""
df_prefs = pd.read_sql(query_prefs, engine)

# Normaliser client_code pour matcher api_ia.py (format "00155" etc.)
df_prefs['client_code'] = df_prefs['client_code'].astype(str).str.strip()
df_prefs['produit_nom'] = df_prefs['produit_nom'].fillna(df_prefs['produit_code']).astype(str).str.strip()

df_prefs.to_csv('preferences_clients_produits.csv', index=False)

print("SUCCES ! L'IA a appris tes vrais prix et les vraies habitudes de tes clients.")