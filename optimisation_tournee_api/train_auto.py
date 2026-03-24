import pandas as pd
import numpy as np
import joblib
from xgboost import XGBRegressor
from sqlalchemy import create_engine
from sklearn.model_selection import train_test_split  # <-- ZEDNA HEDHI
from sklearn.metrics import r2_score                  # <-- ZEDNA HEDHI
import warnings
warnings.filterwarnings('ignore')

print("Connexion a la base de donnees MySQL (dist_utic)...")
engine = create_engine('mysql+pymysql://root:@localhost/dist_utic')

print("Extraction de l'historique VRAI (Ventes + Produits)...")
query_ventes = """
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

print("Entrainement du modele en cours (ca peut prendre quelques secondes)...")
X_raw = df_ml.drop(columns=['vente_nette', 'client_code'])
y = df_ml['vente_nette']

X = pd.get_dummies(X_raw).astype(int)
joblib.dump(list(X.columns), 'colonnes_ia.pkl')

# 🔥 LE VRAI TRAIN/TEST SPLIT KIMA B3ATHTOU ENTI 🔥
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.15, random_state=42)

# Les memes parametres XGBoost elli khtarthom enti
model = XGBRegressor(
    n_estimators=1000,
    learning_rate=0.03,
    max_depth=10,
    subsample=0.9,
    colsample_bytree=0.9,
    random_state=42
)
model.fit(X_train, y_train)

# 🔥 CALCUL DU TAUX DE CONFIANCE (ACCURACY) 🔥
y_pred = model.predict(X_test)

# L'IA ta7seb 9adeh ghlotet fel flous (Marge d'erreur MAPE)
erreur_moyenne = np.mean(np.abs((y_test - y_pred) / np.maximum(y_test, 1)))

# El Confiance hiya 100% w nna9sou menha l'erreur
confiance_pourcentage = round(max(0, 100 - (erreur_moyenne * 100)), 1)

print(f" TAUX DE CONFIANCE (ACCURACY) : {confiance_pourcentage} %")

# 🔥 SAUVEGARDE DU VRAI SCORE POUR LE REACT 🔥
with open('precision.txt', 'w') as f:
    f.write(str(confiance_pourcentage))

joblib.dump(model, 'modele_nomadis.pkl')

print("Creation du profil d'achat de chaque client...")
df_ml.to_csv('master_dataset_v3.csv', index=False)

query_prefs = """
    SELECT 
        e.client_code,
        p.famille_code,
        AVG(l.quantite) as qte_moyenne
    FROM lignecommercials l
    JOIN entetecommercials e ON l.entetecommercial_code = e.code
    JOIN produits p ON l.produit_code = p.code
    WHERE e.type IN ('facture', 'bl', 'blf')
    GROUP BY e.client_code, p.famille_code
"""
df_prefs = pd.read_sql(query_prefs, engine)
df_prefs.to_csv('preferences_clients.csv', index=False)

print("SUCCES ! L'IA a appris tes vrais prix et les vraies habitudes de tes clients.")