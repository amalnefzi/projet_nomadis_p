from flask import Flask, request, jsonify
import pandas as pd
import joblib
import numpy as np

app = Flask(__name__)

print("⏳ Chargement de l'IA et des VRAIES données...")
try:
    # Charger le modèle baseline au lieu de XGBoost 
    df_stats = joblib.load('model_baseline.pkl')
    df_master = pd.read_csv('master_dataset_v3.csv')
    
    # 🔥 Préférences produits clients (noms comme en base) 🔥
    try:
        df_prefs = pd.read_csv('preferences_clients_produits.csv')
    except Exception:
        # Fallback: ancien fichier (par familles) si pas encore ré-entraîné
        df_prefs = pd.read_csv('preferences_clients.csv')
    print("✅ IA Prête avec les données réelles !")
except Exception as e:
    print(f"❌ Erreur de chargement : {e}")
    df_prefs = pd.DataFrame(columns=['client_code', 'produit_nom', 'produit_code', 'qte_moyenne'])

@app.route('/api/predict', methods=['POST'])
def predict_tournee():
    try:
        data = request.json
        date_str = data.get('date', '2026-03-15')
        jour_semaine = pd.to_datetime(date_str).weekday() # Lundi=0, Dimanche=6

        print(f"🔍 Prédiction demandée pour le jour : {jour_semaine} (Date: {date_str})")

        # Filtrer pour les clients qui achètent souvent ce jour-là
        clients_du_jour = df_master[df_master['jour_semaine'] == jour_semaine].copy()
        clients_du_jour = clients_du_jour.drop_duplicates(subset=['client_code'])

        if clients_du_jour.empty:
            return jsonify({"status": "error", "message": "Pas d'historique pour ce jour."})

        # 🧠 PRÉDICTIONS BASELINE STATISTIQUE 🧠
        # Chercher la prédiction dans les statistiques précalculées
        predictions = []
        for _, row in clients_du_jour.iterrows():
            client = str(row['client_code']).strip()
            jour = row['jour_semaine']
            
            # Chercher dans df_stats
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
                # Fallback global
                pred = float(df_master[df_master['jour_semaine'] == jour]['vente_nette'].median()) if jour in df_master['jour_semaine'].values else float(df_master['vente_nette'].median())
            
            predictions.append(max(1, pred))  # Min 1 TND
        
        clients_du_jour['Vn_predit'] = predictions
        
        # Calcul des scores VIP (importance relative) et confiance dynamique
        max_vn = clients_du_jour['Vn_predit'].max()
        max_visites = clients_du_jour['nbr_visites'].max() if 'nbr_visites' in clients_du_jour.columns else 1
        
        def build_confidence(row):
            visites = int(row.get('nbr_visites', 0)) if pd.notna(row.get('nbr_visites')) else 0
            base = 20
            if visites >= 1:
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
            
            # ajouter un bonus si le client fait partie des plus grosses prévisions
            if max_vn > 0:
                volume_ratio = row['Vn_predit'] / max_vn
                bonus = min(15, int(volume_ratio * 15))
            else:
                bonus = 0
            
            score = min(100, base + bonus)
            return round(score, 1)

        clients_du_jour['Confidence'] = clients_du_jour.apply(build_confidence, axis=1)
        clients_du_jour['VIP'] = clients_du_jour.apply(lambda row: int((row['Vn_predit'] / max_vn) * 100) if max_vn > 0 else 0, axis=1)
        if max_vn > 0:
            clients_du_jour['Score'] = (clients_du_jour['Vn_predit'] / max_vn) * 100
        else:
            clients_du_jour['Score'] = 0
            
        result_dict = {}
        for _, row in clients_du_jour.iterrows():
            
            # 🔥 CLIENT CODE FORMAT: Direct depuis le CSV (déjà normalisé "00155" par train_auto.py)
            raw_code = str(row['client_code']).strip()
            # Si c'est un float comme "155.0", le convertir en "00155"
            try:
                code_str = str(int(float(raw_code))).zfill(5)
            except ValueError:
                code_str = raw_code.zfill(5) if len(raw_code) < 5 else raw_code
            
            # 🔥 Extraction des quantités par produit 🔥
            # Chercher avec le format normalisé "00155"
            if 'client_code' in df_prefs.columns and not df_prefs.empty:
                df_prefs_filtered = df_prefs[df_prefs['client_code'].astype(str).str.strip() == code_str]
            else:
                df_prefs_filtered = pd.DataFrame()
            
            details_qte = {}
            total_qte = 0
            
            if not df_prefs_filtered.empty:
                print(f"✅ Client {code_str}: {len(df_prefs_filtered)} produits trouvés")
                for _, p_row in df_prefs_filtered.iterrows():
                    produit = str(p_row.get('produit_nom', '')).strip()
                    if not produit or produit == 'nan':
                        produit = str(p_row.get('produit_code', 'Produit')).strip()
                    if not produit or produit == 'Produit' or produit == 'nan':
                        produit = 'Standard'
                    
                    qte_moy = int(np.maximum(1, p_row['qte_moyenne'])) if pd.notna(p_row['qte_moyenne']) else 1
                    details_qte[produit] = qte_moy
                    total_qte += qte_moy
                print(f"   → Total: {total_qte} unités, Produits: {list(details_qte.keys())[:5]}")
            else:
                # Si pas d'historique précis, on estime
                print(f"⚠️ Client {code_str}: Pas de produits dans preferences_clients_produits.csv")
                total_qte = int(np.maximum(1, row['Vn_predit'] / 50))
                details_qte = {"Standard": total_qte}

            result_dict[code_str] = {
                "score": round(row['Score'], 1),
                "confidence": round(row.get('Confidence', row['Score']), 1),
                "vip": int(row.get('VIP', round(row['Score'], 0))),
                "qte": total_qte,
                "chiffre": round(row['Vn_predit'], 2),
                "details": details_qte # Prêt pour afficher Produit: Quantité
            }

        return jsonify({"status": "success", "predictions": result_dict})

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

if __name__ == '__main__':
    app.run(port=5001, debug=True)