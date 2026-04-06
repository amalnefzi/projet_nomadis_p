## 🚀 Guide d'Installation et d'Exécution

### Étape 1 : Configuration de la Base de données
1. Ouvrez phpMyAdmin (ou votre client MySQL).
2. Créez une base de données nommée `dist_utic` (si elle n'existe pas).
3. Importez le fichier SQL présent dans le backend : `dist_utic.sql`.

### Étape 2 : Lancement du Backend (API Node.js)
1. Ouvrez un **1er terminal** et naviguez dans le dossier de l'API :
   `cd optimisation_tournee_api`
2. Créez un fichier `.env` à la racine de ce dossier :
   `DB_HOST=localhost`
   `DB_USER=root`
   `DB_PASS=`
   `DB_NAME=dist_utic`
   `PORT=5000`
3. Installez les dépendances et démarrez le serveur :
   `npm install`
   `node server.js`
   > L'API Node sera accessible sur `http://localhost:5000`

### Étape 3 : Lancement du Serveur IA (Flask / Python)
1. Ouvrez un **2ème terminal** et naviguez toujours dans `optimisation_tournee_api`.
2. Installez les bibliothèques requises :
   `pip install flask pandas numpy xgboost scikit-learn sqlalchemy pymysql joblib`
3. Démarrez le microservice de l'IA :
   `python api_ia.py`
   > Le serveur IA sera accessible sur `http://127.0.0.1:5001`

### Étape 4 : Lancement du Frontend (React)
1. Ouvrez un **3ème terminal** et naviguez dans le dossier du frontend :
   `cd optimisation_tournee_front`
2. Installez les dépendances et démarrez l'application :
   `npm install`
   `npm run dev`
   > L'interface utilisateur s'ouvrira sur `http://localhost:5173`