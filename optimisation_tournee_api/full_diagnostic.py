import pandas as pd
import numpy as np
from sqlalchemy import create_engine, text

print("="*80)
print("🔍 DIAGNOSTIC COMPLET DES DONNÉES")
print("="*80)

# 1. Vérifier les données brutes MySQL
print("\n1️⃣ DONNÉES BRUTES MySQL")
print("-"*80)

engine = create_engine('mysql+pymysql://root:@localhost/dist_utic')

query = """
SELECT 
    e.client_code,
    c.region,
    c.potentiel,
    e.date,
    DAYOFWEEK(e.date) - 1 as jour_semaine,
    e.net_a_payer as vente_nette
FROM entetecommercials e
JOIN clients c ON e.client_code = c.code
WHERE e.type IN ('facture', 'bl', 'blf') AND e.net_a_payer > 0
LIMIT 100
"""

df_raw = pd.read_sql(query, engine)
print(f"✅ {len(df_raw)} lignes récupérées")
print("\n📋 APERÇU:")
print(df_raw.head(20))

print("\n📊 STATISTIQUES:")
print(f"  client_code uniques: {df_raw['client_code'].nunique()}")
print(f"  region uniques: {df_raw['region'].nunique()}")
print(f"  region valeurs: {df_raw['region'].unique()[:10]}")
print(f"  potentiel uniques: {df_raw['potentiel'].nunique()}")
print(f"  potentiel valeurs: {df_raw['potentiel'].unique()}")
print(f"  jour_semaine uniques: {df_raw['jour_semaine'].nunique()}")

print(f"\n  Ventes min: {df_raw['vente_nette'].min():.2f}")
print(f"  Ventes max: {df_raw['vente_nette'].max():.2f}")
print(f"  Ventes moyenne: {df_raw['vente_nette'].mean():.2f}")
print(f"  Ventes std: {df_raw['vente_nette'].std():.2f}")

# 2. Vérifier les données après groupby
print("\n\n2️⃣ APRÈS GROUPBY (COMME DANS TRAIN_AUTO)")
print("-"*80)

df_raw['date'] = pd.to_datetime(df_raw['date'], errors='coerce')
df_raw = df_raw.dropna(subset=['date'])

df_ml = df_raw.groupby(['client_code', 'region', 'potentiel', 'jour_semaine']).agg(
    nbr_visites=('vente_nette', 'count'),
    vente_nette=('vente_nette', 'mean')
).reset_index()
df_ml = df_ml.fillna('Inconnu')
df_ml['client_code'] = df_ml['client_code'].astype(str).str.strip()

print(f"✅ {len(df_ml)} lignes après groupby")
print("\n📋 APERÇU:")
print(df_ml.head(20))

print("\n📊 DISTRIBUTION:")
print(f"  Clients uniques: {df_ml['client_code'].nunique()}")
print(f"  Régions: {df_ml['region'].unique()}")
print(f"  Potentiels: {df_ml['potentiel'].unique()}")
print(f"  Visites (count): min={df_ml['nbr_visites'].min()}, max={df_ml['nbr_visites'].max()}")

# 3. Vérifier la corrélation
print("\n\n3️⃣ CORRÉLATION DES FEATURES")
print("-"*80)

print("\nAnalyse des features pour prédiction:")
X_raw = df_ml.drop(columns=['vente_nette', 'client_code'])
print(f"Features brutes: {list(X_raw.columns)}")
print(f"\nCaractéristiques:")
for col in X_raw.columns:
    print(f"  {col}: type={X_raw[col].dtype}, uniques={X_raw[col].nunique()}")

X = pd.get_dummies(X_raw).astype(int)
print(f"\nAprès get_dummies: {X.shape[1]} colonnes")
print(f"Colonnes: {list(X.columns)}")

# Corrélation avec vente_nette
y = df_ml['vente_nette'].values
correlations = []
for col in X.columns:
    corr = np.corrcoef(X[col].values, y)[0,1]
    correlations.append((col, corr))

correlations.sort(key=lambda x: abs(x[1]), reverse=True)
print(f"\n🔗 TOP Corrélations avec vente_nette:")
for col, corr in correlations[:10]:
    print(f"  {col}: {corr:.4f}")

# 4. Vérifier la variance
print("\n\n4️⃣ VARIANCE DES DONNÉES")
print("-"*80)

y_log = np.log1p(df_ml['vente_nette'].values)
print(f"Y (original) - Variance: {np.var(df_ml['vente_nette'].values):.4f}")
print(f"Y (log) - Variance: {np.var(y_log):.4f}")
print(f"\nRatio variance/mean Y: {np.var(df_ml['vente_nette'].values) / np.mean(df_ml['vente_nette'].values):.2f}")
print("(Si ratio > 1 = très bruyant)")

# 5. Recommandations
print("\n\n5️⃣ RECOMMANDATIONS")
print("-"*80)

if df_ml['region'].isna().sum() > 0 or (df_ml['region'] == 'Inconnu').sum() > 0:
    print("⚠️  Valeurs manquantes dans 'region'")

if df_ml['potentiel'].isna().sum() > 0 or (df_ml['potentiel'] == 'Inconnu').sum() > 0:
    print("⚠️  Valeurs manquantes dans 'potentiel'")

if np.var(df_ml['vente_nette'].values) / np.mean(df_ml['vente_nette'].values) > 5:
    print("⚠️  Les données sont TRÈS bruyantes (variance élevée)")
    print("   → Impossible de prédire sans plus de structure")

if len(X.columns) > len(df_ml) / 5:
    print("⚠️  Trop de features par rapport aux données")
    print(f"   → Features: {len(X.columns)}, Données: {len(df_ml)}")

print("\n✅ Diagnostic terminé")
