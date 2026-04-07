#!/usr/bin/env python3
"""
APPROCHE SIMPLIFIÉE: Statistique Bayésienne Simple
Plus robuste que XGBoost avec peu de données
"""

import pandas as pd
import numpy as np
import joblib
from sqlalchemy import create_engine
from sklearn.metrics import r2_score, mean_absolute_percentage_error
import warnings
warnings.filterwarnings('ignore')

print("=" * 80)
print("🚀 ENTRAÎNEMENT SIMPLIFIÉ - Baseline Statistique")
print("=" * 80)

engine = create_engine('mysql+pymysql://root:@localhost/dist_utic')

print("\n1️⃣ Extraction des données...")
query_ventes = """
    SELECT 
        LPAD(e.client_code, 5, '0') as client_code,
        DAYOFWEEK(e.date) - 1 as jour_semaine,
        e.net_a_payer as vente_nette
    FROM entetecommercials e
    WHERE e.type IN ('facture', 'bl', 'blf') AND e.net_a_payer > 0
"""
df_raw = pd.read_sql(query_ventes, engine)
print(f"   ✅ {len(df_raw)} factures récupérées")

# Pour tester: utiliser last 20% des données
from sklearn.model_selection import train_test_split

df_train, df_test = train_test_split(df_raw, test_size=0.20, random_state=42)
print(f"   Entraînement: {len(df_train)} | Test: {len(df_test)}")

print("\n2️⃣ Calcul des statistiques par CLIENT + JOUR...")
# Pour chaque client-jour, calculer: vente_moyenne, vente_median, min, max, std, count
df_stats = df_train.groupby(['client_code', 'jour_semaine']).agg(
    vente_mean=('vente_nette', 'mean'),
    vente_median=('vente_nette', 'median'),
    vente_count=('vente_nette', 'count'),
    vente_std=('vente_nette', 'std'),
    vente_min=('vente_nette', 'min'),
    vente_max=('vente_nette', 'max')
).reset_index()

# Statistiques par client globales
client_stats = df_train.groupby('client_code').agg(
    client_mean=('vente_nette', 'mean'),
    client_median=('vente_nette', 'median'),
    client_count=('vente_nette', 'count')
).reset_index()

# Remplir std pour single observations
df_stats['vente_std'] = df_stats['vente_std'].fillna(0)
print(f"   ✅ {len(df_stats)} combinaisons client-jour")

print("\n3️⃣ Données globales (fallback)...")
# Statistiques globales par jour
global_by_day = df_train.groupby('jour_semaine')['vente_nette'].agg(['mean', 'median', 'std']).reset_index()
global_by_day.columns = ['jour_semaine', 'global_mean', 'global_median', 'global_std']
print(f"   ✅ Moyennes par jour calculées")

print("\n4️⃣ Fusion et préparation...")
df_stats = df_stats.merge(global_by_day, on='jour_semaine')
df_stats = df_stats.merge(client_stats, on='client_code', how='left')
df_stats.fillna(0, inplace=True)
print(f"   ✅ {len(df_stats)} lignes pour prédiction")

# Sauvegarder les statistiques
joblib.dump(df_stats, 'model_baseline.pkl')
print("   ✅ Modèle sauvegardé")

print("\n5️⃣ Calcul de la précision...")

# Prédictions sur test set
y_pred = []
y_actual = []

for _, row in df_test.iterrows():
    client = str(row['client_code']).zfill(5)
    jour = row['jour_semaine']
    
    # Chercher la prédiction dans les données d'entraînement
    row_match = df_stats[(df_stats['client_code'] == client) & (df_stats['jour_semaine'] == jour)]
    
    if not row_match.empty:
        row_match = row_match.iloc[0]
        if row_match['vente_count'] >= 3:
            pred = float(row_match['vente_median'])
        elif row_match['client_count'] >= 3:
            pred = 0.7 * float(row_match['client_median']) + 0.3 * float(row_match['global_median'])
        else:
            pred = float(row_match['client_mean']) if row_match['client_count'] >= 1 else float(row_match['global_median'])
    else:
        # Fallback: moyenne globale ou médiane globale
        global_row = global_by_day[global_by_day['jour_semaine'] == jour]
        if len(global_row) > 0:
            pred = float(global_row.iloc[0]['global_median'])
        else:
            pred = float(df_train['vente_nette'].median())

    y_pred.append(max(1, pred))  # Min 1 TND
    y_actual.append(row['vente_nette'])

y_pred = np.array(y_pred)
y_actual = np.array(y_actual)

# Calcule R² et MAPE
r2 = r2_score(y_actual, y_pred)
mape = mean_absolute_percentage_error(y_actual, y_pred)

# Score de qualité de la prédiction: 100/(1 + MAPE)
# Cela reste entre 0 et 100 même si l'erreur est >100%
quality_score = round(100 / (1 + mape), 1)

print(f"\n✅ RÉSULTATS:")
print(f"   R² Score: {r2:.4f}")
print(f"   MAPE: {mape*100:.1f}%")
print(f"   Score de qualité: {quality_score}%")
print(f"   (1 / (1 + MAPE) => valeur bornée entre 0 et 100)")

# Sauvegarder la précision
with open('precision.txt', 'w') as f:
    f.write(str(quality_score))

print("\n" + "="*80)
print(f"✅ ENTRAÎNEMENT RÉUSSI - Score de qualité: {quality_score}%")
print("="*80)

print("\n💡 TYPE DE MODÈLE: Baseline Statistique Simple")
print("   - Prédiction = Vente moyenne du client ce jour-là")
print("   - Fallback = Vente moyenne globale si client inexistant")
print("   - Simple, robuste, pas d'overfitting")
