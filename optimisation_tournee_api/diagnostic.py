import pandas as pd
import numpy as np

print("="*60)
print("DIAGNOSTIC DES DONNÉES D'ENTRAÎNEMENT")
print("="*60)

df = pd.read_csv('master_dataset_v3.csv')

print(f"\n✅ Lignes: {len(df)}")
print(f"✅ Colonnes: {list(df.columns)}")

print("\n📊 LES DONNÉES:")
print(df.head(10))

print("\n📈 STATISTIQUES VENTES:")
print(df['vente_nette'].describe())

print("\n🔍 VÉRIFICATIONS:")
print(f"Valeurs NaN: {df.isna().sum().sum()}")
print(f"Ventes négatives: {(df['vente_nette'] < 0).sum()}")
print(f"Ventes à zéro: {(df['vente_nette'] == 0).sum()}")

print("\n💡 PROBLÈMES POSSIBLES:")
if (df['vente_nette'] < 0).sum() > 0:
    print("❌ Ventes négatives trouvées! C'est mauvais pour l'entraînement")
    
if df['vente_nette'].std() > df['vente_nette'].mean():
    print("❌ Variabilité très haute (std > mean)")
    print("   L'IA aura du mal à prédire")

if len(df) < 100:
    print("❌ Pas assez de données (<100)")
    
print("\n✅ Vérification réussie")
