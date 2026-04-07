# 🚀 DÉMARRAGE RAPIDE - Nomadis IA

## ⚡ EN MOINS DE 5 MINUTES

### 1️⃣ Configuration Initiale (une seule fois)
```bash
cd optimisation_tournee_api
python setup_ia.py
```

### 2️⃣ Lancer les 3 services (3 terminaux différents)

#### Terminal 1 - API Node.js (le cerveau des commandes)
```bash
cd optimisation_tournee_api
node server.js
```
✅ API accessible sur: `http://localhost:5000`

#### Terminal 2 - Serveur Python/IA (le machine learning)
```bash
cd optimisation_tournee_api
python api_ia.py
```
✅ IA accessible sur: `http://127.0.0.1:5001`

#### Terminal 3 - Interface React (le dashboard)
```bash
cd optimisation_tournee_front
npm install  # (si pas encore fait)
npm run dev
```
✅ Interface sur: `http://localhost:5173`

---

## 🎯 UTILISATION

1. **Ouvrir** `http://localhost:5173` dans votre navigateur
2. **Sélectionner** une date et cliquer sur "Analyser avec l'IA" 📊
3. **Voir** les prédictions en temps réel avec:
   - Score VIP pour chaque client
   - Chiffre prédit (en TND)
   - Quantités recommandées par produit
4. **Cliquer** "Mettre à jour le Cerveau IA" pour re-entraîner avec les nouvelles données 🧠

---

## 🔧 TROUBLESHOOTING

### ❌ "MySQL non connecté"
- Lancez XAMPP et assurez-vous que MySQL est démarré
- Vérifiez que `dist_utic` base existe

### ❌ "Erreur IA ou prédictions nulles"
```bash
# Relancer l'entraînement
python train_auto.py

# Vérifier les données
python verify_data.py
```

### ❌ "Serveur Python ne répond pas"
- Vérifiez que `python api_ia.py` tourne bien
- Vérifiez le port `5001` est libre
- Relancez le script

---

## 📊 AUTOMATISATIONS

✅ **L'IA s'entraîne automatiquement:**
- ✨ Au démarrage du serveur Node.js
- ✨ Toutes les 12 heures en arrière-plan
- ✨ À la demande via le bouton "Mettre à jour le Cerveau IA"

✅ **Les prédictions s'actualisent:**
- ✨ Chaque fois que vous cliquez "Analyser avec l'IA"
- ✨ Basées sur les données précises de MySQL
- ✨ Affichent la précision réelle (% de confiance IA)

---

## 📝 FICHIERS CLÉS

| Fichier | Rôle |
|---------|------|
| `server.js` | API Node.js (routes, bdd, orchestre l'IA) |
| `api_ia.py` | Prédictions temps réel (XGBoost) |
| `train_auto.py` | Entraînement du modèle IA |
| `verify_data.py` | Vérification cohérence données |
| `setup_ia.py` | Configuration initiale |

---

## 💡 CONSEILS

- Les prédictions utilisent les **vraies données MySQL** (pas d'estimation)
- Le modèle IA apprend des **ventes réelles**
- La précision affichée compare prédictions vs réalité historique
- En cas de changement de données, relancez "Mettre à jour le Cerveau IA"

---

## 🎓 ARCHITECTURE

```
React (Dashboard) ←→ Node.js API ←→ MySQL (Données réelles)
                         ↓
                    Python/IA ←→ ML Model (XGBoost)
```

- **React** = Interface utilisateur
- **Node.js** = Orchestration + API REST
- **Python/Flask** = Machine Learning en temps réel
- **MySQL** = Données business (clients, ventes, produits)

---

**Version:** 1.0  
**Dernière mise à jour:** Avril 2026
