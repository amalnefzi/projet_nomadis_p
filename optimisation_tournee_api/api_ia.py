from flask import Flask, request, jsonify
import pandas as pd
import joblib
import numpy as np

app = Flask(__name__)

print("⏳ Chargement de l'IA et des VRAIES données...")
try:
    model = joblib.load('modele_nomadis.pkl')
    cols_ia = joblib.load('colonnes_ia.pkl')
    df_master = pd.read_csv('master_dataset_v3.csv')
    
    # 🔥 NOUVEAU: On charge les préférences des clients (Chips, Agro, etc.) 🔥
    df_prefs = pd.read_csv('preferences_clients.csv') 
    print("✅ IA Prête avec les données réelles !")
except Exception as e:
    print(f"❌ Erreur de chargement : {e}")

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

        # Préparation pour XGBoost
        X = pd.get_dummies(clients_du_jour.drop(columns=['vente_nette', 'client_code'])).astype(int)
        X = X.reindex(columns=cols_ia, fill_value=0)
        
        # 🧠 VRAIES PRÉDICTIONS (Fini le * 185, l'IA sort de vrais Dinars !)
        predictions = model.predict(X)
        clients_du_jour['Vn_predit'] = np.maximum(0, predictions)
        
        # Calcul des scores VIP
        max_vn = clients_du_jour['Vn_predit'].max()
        if max_vn > 0:
            clients_du_jour['Score'] = (clients_du_jour['Vn_predit'] / max_vn) * 100
        else:
            clients_du_jour['Score'] = 0
            
        result_dict = {}
        for _, row in clients_du_jour.iterrows():
            
            raw_code = str(row['client_code']).strip()
            try:
                code_str = str(int(float(raw_code))).zfill(5)
            except ValueError:
                code_str = raw_code
                
            # 🔥 NOUVEAU: Extraction des quantités exactes par produit 🔥
            prefs_client = df_prefs[df_prefs['client_code'] == raw_code]
            details_qte = {}
            total_qte = 0
            
            if not prefs_client.empty:
                for _, p_row in prefs_client.iterrows():
                    famille = str(p_row['famille_code'])
                    qte_moy = int(np.maximum(1, p_row['qte_moyenne'])) if pd.notna(p_row['qte_moyenne']) else 1
                    details_qte[famille] = qte_moy
                    total_qte += qte_moy
            else:
                # Si pas d'historique précis, on estime
                total_qte = int(np.maximum(1, row['Vn_predit'] / 50))
                details_qte = {"Standard": total_qte}

            result_dict[code_str] = {
                "score": round(row['Score'], 1),
                "qte": total_qte, 
                "chiffre": round(row['Vn_predit'], 2),
                "details": details_qte # Prêt pour afficher "Chips: 5", "Agro: 3"
            }

        return jsonify({"status": "success", "predictions": result_dict})

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

if __name__ == '__main__':
    app.run(port=5001, debug=True)