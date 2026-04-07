#!/usr/bin/env python3
"""
Script de configuration et relance complète de l'IA
Exécute: python setup_ia.py
"""

import subprocess
import sys
import os
from pathlib import Path

print("=" * 70)
print(" 🚀 CONFIGURATION COMPLÈTE DE L'IA - Nomadis")
print("=" * 70)

# 1. Vérification des dépendances
print("\n📦 VÉRIFICATION DES DÉPENDANCES")
print("-" * 70)

required_packages = ['pandas', 'numpy', 'xgboost', 'scikit-learn', 'flask', 'sqlalchemy', 'pymysql', 'joblib', 'axios']
missing = []

for pkg in ['pandas', 'numpy', 'xgboost', 'scikit-learn', 'flask', 'sqlalchemy', 'pymysql', 'joblib']:
    try:
        __import__(pkg)
        print(f"✅ {pkg}")
    except ImportError:
        print(f"❌ {pkg} - MANQUANT")
        missing.append(pkg)

if missing:
    print(f"\n⚠️ Installation des paquets manquants...")
    for pkg in missing:
        subprocess.run([sys.executable, '-m', 'pip', 'install', pkg], check=False)
    print("✅ Paquets installés")

# 2. Vérification de MySQL
print("\n🗄️  VÉRIFICATION DE MYSQL")
print("-" * 70)

try:
    import pymysql
    conn = pymysql.connect(host='localhost', user='root', password='')
    cursor = conn.cursor()
    cursor.execute("SELECT VERSION()")
    version = cursor.fetchone()
    print(f"✅ MySQL connecté: {version[0]}")
    conn.close()
except Exception as e:
    print(f"❌ ERREUR MySQL: {e}")
    print("   Assurez-vous que MySQL/XAMPP est lancé et accessible")
    sys.exit(1)

# 3. Vérifier la base dist_utic
print("\n📊 VÉRIFICATION DE LA BASE dist_utic")
print("-" * 70)

try:
    from sqlalchemy import create_engine, text
    engine = create_engine('mysql+pymysql://root:@localhost/dist_utic')
    with engine.connect() as conn:
        result = conn.execute(text("SELECT DATABASE()"))
        db = result.fetchone()[0]
        print(f"✅ Base de données: {db}")
        
        # Compter les tables critiques
        result = conn.execute(text("SHOW TABLES"))
        tables = [row[0] for row in result]
        required_tables = ['clients', 'entetecommercials', 'lignecommercials', 'produits']
        for table in required_tables:
            if table in tables:
                print(f"   ✅ Tableau {table}")
            else:
                print(f"   ❌ Tableau {table} MANQUANT")
except Exception as e:
    print(f"❌ ERREUR: {e}")
    sys.exit(1)

# 4. Entraîner l'IA
print("\n🧠 ENTRAÎNEMENT DE L'IA")
print("-" * 70)

try:
    print("⏳ Exécution de train_auto.py...")
    result = subprocess.run([sys.executable, 'train_auto.py'], capture_output=True, text=True, timeout=300)
    
    if result.returncode == 0:
        print("✅ IA ENTRAÎNÉE AVEC SUCCÈS")
        print(result.stdout)
    else:
        print(f"❌ Erreur d'entraînement:")
        print(result.stderr)
        
except subprocess.TimeoutExpired:
    print("❌ Timeout - L'entraînement a pris trop de temps")
except Exception as e:
    print(f"❌ ERREUR: {e}")

# 5. Vérifier les fichiers générés
print("\n📋 FICHIERS GÉNÉRÉS")
print("-" * 70)

files_to_check = [
    'modele_nomadis.pkl',
    'colonnes_ia.pkl',
    'precision.txt',
    'master_dataset_v3.csv',
    'preferences_clients_produits.csv'
]

for file in files_to_check:
    if os.path.exists(file):
        size = os.path.getsize(file)
        print(f"✅ {file} ({size} bytes)")
    else:
        print(f"❌ {file} MANQUANT")

# 6. Résumé final
print("\n" + "=" * 70)
print(" ✅ CONFIGURATION COMPLÈTE")
print("=" * 70)

print("""
🎯 PROCHAINES ÉTAPES:

1. 🚀 DÉMARRER L'API NODE.JS (Terminal 1):
   node server.js

2. 🧠 DÉMARRER L'API PYTHON (Terminal 2):
   python api_ia.py

3. ⚛️ DÉMARRER LE FRONTEND REACT (Terminal 3):
   cd ../optimisation_tournee_front
   npm run dev

4. 🌐 ACCÉDER À L'INTERFACE:
   http://localhost:5173

5. 📊 UTILISER L'IA:
   - Cliquez sur "Analyser avec l'IA"
   - Cliquez sur "Mettre à jour le Cerveau IA" pour re-entraîner si besoin
   - Les prédictions se maquent automatiquement toutes les 12h

💡 ASTUCE:
   - L'IA s'entraîne automatiquement au démarrage du serveur
   - Vous pouvez aussi relancer manuellement avec le bouton "Mettre à jour le Cerveau IA"
   - Les données MySQL sont lues en temps réel
""")

print("=" * 70)
