#!/usr/bin/env python3
"""
Script de vérification et correction des données IA
Utilise ceci avant de relancer l'apprentissage pour vérifier les cohérences
"""

import pandas as pd
import numpy as np
from sqlalchemy import create_engine
import joblib
import os

print("=" * 60)
print("🔍 VÉRIFICATION DES DONNÉES IA - Nomadis")
print("=" * 60)

# 1. Vérifier les fichiers CSV
print("\n📋 VÉRIFICATION DES FICHIERS CSV")
print("-" * 60)

csv_files = {
    'master_dataset_v3.csv': ['client_code', 'region', 'potentiel', 'jour_semaine', 'nbr_visites', 'vente_nette'],
    'preferences_clients_produits.csv': ['client_code', 'produit_code', 'produit_nom', 'qte_moyenne']
}

for csv_name, expected_cols in csv_files.items():
    try:
        df = pd.read_csv(csv_name)
        print(f"\n✅ {csv_name}: {len(df)} lignes")
        
        # Vérifier les colonnes
        missing_cols = [c for c in expected_cols if c not in df.columns]
        if missing_cols:
            print(f"   ⚠️ Colonnes manquantes: {missing_cols}")
        else:
            print(f"   ✅ Colonnes OK: {', '.join(expected_cols)}")
        
        # Vérifier les doublons
        if 'client_code' in df.columns:
            na_count = df['client_code'].isna().sum()
            if na_count > 0:
                print(f"   ⚠️ {na_count} client_code manquants")
            
            # Format des client_code
            sample_codes = df['client_code'].astype(str).head(3).tolist()
            print(f"   📌 Format client_code: {sample_codes}")
    except Exception as e:
        print(f"\n❌ {csv_name}: Erreur - {e}")

# 2. Vérifier la base de données
print("\n\n📊 VÉRIFICATION DE LA BASE DE DONNÉES")
print("-" * 60)

try:
    engine = create_engine('mysql+pymysql://root:@localhost/dist_utic')
    
    # Compter les documents de vente
    query = "SELECT COUNT(*) as cnt FROM entetecommercials WHERE type IN ('facture', 'bl', 'blf') AND net_a_payer > 0"
    df_count = pd.read_sql(query, engine)
    print(f"✅ Documents de vente (facture/BL/BLF): {df_count['cnt'].iloc[0]}")
    
    # Compter les lignes de produits
    query2 = "SELECT COUNT(*) as cnt FROM lignecommercials WHERE entetecommercial_code IN (SELECT code FROM entetecommercials WHERE type IN ('facture', 'bl', 'blf'))"
    df_count2 = pd.read_sql(query2, engine)
    print(f"✅ Lignes de produits: {df_count2['cnt'].iloc[0]}")
    
    # Vérifier les clients
    query3 = "SELECT COUNT(*) as cnt FROM clients WHERE isactif = '1' AND deleted_at IS NULL"
    df_count3 = pd.read_sql(query3, engine)
    print(f"✅ Clients actifs: {df_count3['cnt'].iloc[0]}")
    
except Exception as e:
    print(f"❌ Erreur de connexion MySQL: {e}")

# 3. Vérifier le modèle IA
print("\n\n🧠 VÉRIFICATION DU MODÈLE IA")
print("-" * 60)

try:
    if os.path.exists('modele_nomadis.pkl'):
        model = joblib.load('modele_nomadis.pkl')
        print(f"✅ Modèle chargé: {type(model).__name__}")
        print(f"   - Estimateurs: {model.n_estimators if hasattr(model, 'n_estimators') else 'N/A'}")
    else:
        print("⚠️ Modèle non trouvé - Veuillez exécuter train_auto.py")
except Exception as e:
    print(f"❌ Erreur modèle: {e}")

try:
    if os.path.exists('colonnes_ia.pkl'):
        cols = joblib.load('colonnes_ia.pkl')
        print(f"✅ Colonnes IA: {len(cols)} colonnes")
    else:
        print("⚠️ Colonnes IA non trouvées")
except Exception as e:
    print(f"❌ Erreur colonnes: {e}")

try:
    if os.path.exists('precision.txt'):
        with open('precision.txt', 'r') as f:
            precision = f.read().strip()
        print(f"✅ Précision IA: {precision}%")
    else:
        print("⚠️ Fichier précision non trouvé")
except Exception as e:
    print(f"❌ Erreur précision: {e}")

# 4. Vérifier la cohérence master_dataset vs preferences
print("\n\n🔗 COHÉRENCE MASTER_DATASET vs PREFERENCES")
print("-" * 60)

try:
    df_master = pd.read_csv('master_dataset_v3.csv')
    df_prefs = pd.read_csv('preferences_clients_produits.csv')
    
    # Codes clients en commun
    master_codes = set(df_master['client_code'].astype(str).str.strip().unique())
    prefs_codes = set(df_prefs['client_code'].astype(str).str.strip().unique())
    
    print(f"Codes clients dans master_dataset: {len(master_codes)}")
    print(f"Codes clients dans preferences: {len(prefs_codes)}")
    
    common = master_codes & prefs_codes
    print(f"✅ Codes en commun: {len(common)}")
    
    only_master = master_codes - prefs_codes
    only_prefs = prefs_codes - master_codes
    
    if only_master:
        print(f"⚠️ Codes dans master_dataset SEULEMENT: {len(only_master)}")
    if only_prefs:
        print(f"⚠️ Codes dans preferences SEULEMENT: {len(only_prefs)}")
        
except Exception as e:
    print(f"❌ Erreur cohérence: {e}")

print("\n" + "=" * 60)
print("✅ VÉRIFICATION TERMINÉE")
print("=" * 60)
print("\n💡 PROCHAINES ÉTAPES:")
print("   1. Si les données manquent, exécutez: python train_auto.py")
print("   2. Pour tester l'IA, démarrez: python api_ia.py")
print("   3. Vérifiez ensuite l'interface React")
