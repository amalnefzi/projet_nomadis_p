const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. Connexion à la base de données MySQL
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'dist_utic'
});

db.connect(err => {
    if (err) {
        console.error('Erreur SQL de connexion:', err);
        return;
    }
    console.log('Connecté à la base de données dist_utic !');
});

// 2. Route : Récupérer les régions depuis SQL
app.get('/api/regions', (req, res) => {
    db.query('SELECT * FROM regions', (err, results) => {
        if (err) return res.status(500).json({ error: "Erreur SQL", details: err });
        res.json(results);
    });
});

// 3. Route : Lire toutes les données du fichier Excel (Densité)
app.get('/api/densite', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'donnees_clients.csv.xlsx');
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ message: "Fichier donnees_clients.csv.xlsx introuvable" });
        }
        const workbook = XLSX.readFile(filePath);
        const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Erreur lecture Excel", details: err.message });
    }
});

// 4. ROUTE IA : Tournée complète d'une journée (Plusieurs localités + Charge globale)
app.get('/api/ia/suggestion', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'donnees_clients.csv.xlsx');
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ message: "Fichier Excel introuvable" });
        }

        const workbook = XLSX.readFile(filePath);
        const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

        // 1. Regrouper par Gouvernorat (Pour que le livreur reste dans la même zone géographique)
        const analyseRegions = {};

        data.forEach(row => {
            const region = row.gouvernorat;
            if (region && row.localite) {
                if (!analyseRegions[region]) {
                    analyseRegions[region] = { nom: region, scoreTotal: 0, etapes: [] };
                }

                const potentielLocalite = (row.agro || 0) + (row.chips || 0) + (row.bureautique || 0);

                // On ajoute chaque localité avec ses besoins spécifiques
                analyseRegions[region].etapes.push({
                    delegation: row.delegation,
                    localite: row.localite,
                    potentiel: potentielLocalite,
                    besoins: {
                        agro: row.agro || 0,
                        chips: row.chips || 0,
                        bureautique: row.bureautique || 0
                    }
                });

                analyseRegions[region].scoreTotal += potentielLocalite;
            }
        });

        // 2. L'IA choisit le Gouvernorat avec le plus fort potentiel de vente aujourd'hui
        const regionsTriees = Object.values(analyseRegions).sort((a, b) => b.scoreTotal - a.scoreTotal);
        const regionDuJour = regionsTriees[0];

        // 3. Optimisation : On sélectionne les 10 meilleures localités de cette région
        // (Simulation d'une tournée Marguerite : on attaque les gros clients d'abord)
        const etapesDuJour = regionDuJour.etapes
            .sort((a, b) => b.potentiel - a.potentiel)
            .slice(0, 10); // Le livreur fera 10 arrêts aujourd'hui

        // 4. Calcul de la charge TOTALE du camion pour la journée
        const chargeCamion = { agro: 0, chips: 0, bureautique: 0 };
        
        etapesDuJour.forEach(etape => {
            chargeCamion.agro += etape.besoins.agro;
            chargeCamion.chips += etape.besoins.chips;
            chargeCamion.bureautique += etape.besoins.bureautique;
        });

        // 5. On envoie la feuille de route au Front-end
        res.json({
            titre: `Tournée Optimisée - ${regionDuJour.nom}`,
            strategie: "Tournée Marguerite (Regroupement Géographique)",
            nombreArrets: etapesDuJour.length,
            itineraire: etapesDuJour.map(e => `${e.delegation} ➔ ${e.localite}`),
            chargeTotale: chargeCamion
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// 5. Lancement du serveur
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`🚀 Serveur API prêt sur : http://localhost:${PORT}`);
    console.log(`👉 Route IA : http://localhost:${PORT}/api/ia/suggestion`);
    console.log(`===========================================`);
});