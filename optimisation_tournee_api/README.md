# 🚚 Nomadis - Système d'Optimisation de Tournées avec IA

Ce projet est une solution complète pour gérer et optimiser les tournées commerciales de la société Nomadis. L'application utilise un algorithme d'Intelligence Artificielle pour analyser le potentiel commercial et suggérer le meilleur itinéraire et le chargement idéal du camion.

##  Architecture du Projet
Ce dépôt contient deux parties principales :
* `optimisation_tournee_api` : Le Backend (Serveur Node.js / Express / MySQL)
* `optimisation_tournee_front` : Le Frontend (Interface utilisateur React / Vite)

## ⚙️ Prérequis
* [Node.js](https://nodejs.org/) installé sur votre machine.
* Un serveur MySQL local (ex: XAMPP, WAMP, ou phpMyAdmin).

---

##  Guide d'Installation et d'Exécution

### Étape 1 : Configuration de la Base de données
1. Ouvrez phpMyAdmin (ou votre client MySQL).
2. Créez une base de données nommée `dist_utic` (si elle n'existe pas).
3. Importez le fichier SQL présent dans le backend : `dist_utic.sql`.

### Étape 2 : Lancement du Backend (API & Moteur IA)
1. Ouvrez un terminal et naviguez dans le dossier de l'API :
   `cd optimisation_tournee_api`
2. Créez un fichier `.env` à la racine de ce dossier et ajoutez vos identifiants :
   `DB_HOST=localhost`
   `DB_USER=root`
   `DB_PASS=`
   `DB_NAME=dist_utic`
   `PORT=5000`
3. Installez les dépendances requises :
   `npm install`
4. Démarrez le serveur :
   `node server.js`
   > L'API sera accessible sur `http://localhost:5000`

### Étape 3 : Lancement du Frontend (React)
1. Ouvrez un **nouveau** terminal et naviguez dans le dossier du frontend :
   `cd optimisation_tournee_front`
2. Installez les dépendances requises :
   `npm install`
3. Démarrez l'application React :
   `npm run dev`
   > L'interface utilisateur s'ouvrira sur `http://localhost:5173`

---

##  Fonctionnalités Actuelles
* Connexion à la base de données pour récupérer les régions.
* Lecture d'un fichier Excel (`donnees_clients.csv.xlsx`) pour calculer la densité des clients.
* **Moteur IA :** Suggestion d'une tournée complète basée sur le potentiel commercial par gouvernorat (stratégie Marguerite) et prédiction du chargement (Agro, Chips, Bureautique).