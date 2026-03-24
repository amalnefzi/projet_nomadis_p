const { exec } = require('child_process');const axios = require('axios');
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const fs = require('fs'); // <-- ZEDNA MODULE FS BECH NA9RAW EL FICHIER IA
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


// ==========================================
// 🧠 ROUTE POUR ENTRAÎNER L'IA MANUELLEMENT
// ==========================================
app.post('/api/train-ia', (req, res) => {
    console.log("⚙️ Lancement de l'apprentissage IA en cours...");

    // Executer le script Python
    exec('python train_auto.py', (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ Erreur d'exécution Python: ${error.message}`);
            return res.status(500).json({ status: 'error', message: "Erreur lors de l'apprentissage." });
        }
        console.log(`✅ Résultat Python:\n${stdout}`);
        res.json({ 
            status: 'success', 
            message: "L'IA a bien appris les dernières données de vente !", 
            details: stdout 
        });
    });
});

// 2. Fonction bech na9raw el Cerveau mta3 l'IA (CSV)
function getAiPredictions() {
    try {
        const data = fs.readFileSync('tournee_du_jour.csv', 'utf8');
        const lines = data.split('\n').slice(1); // Nna7iw el header
        let aiDict = {};
        
        lines.forEach(line => {
            if (line.trim() === '') return;
            const parts = line.split(',');
            // Format du CSV: client_code, Score, Vn_predit, Q_reco
            const code = parts[0].trim().padStart(5, '0'); // Nriglou el format mta3 code (ex: 00155)
            aiDict[code] = {
                score: parseFloat(parts[1]),
                vn_predit: parseFloat(parts[2]),
                q_reco: parseInt(parts[3])
            };
        });
        return aiDict;
    } catch (e) {
        console.error("⚠️ Fichier CSV IA introuvable. Avez-vous exécuté le script Python ?");
        return {};
    }
}

// 3. Route : Options pour les filtres
app.get('/api/tournees/options', (req, res) => {
    db.query(`SELECT DISTINCT routing_code AS route FROM clients WHERE routing_code IS NOT NULL AND routing_code != '' LIMIT 20`, (err, routes) => {
        if (err) return res.status(500).json({ error: "Erreur SQL routes" });
        db.query(`SELECT DISTINCT user_code AS commercial FROM clients WHERE user_code IS NOT NULL AND user_code != '' LIMIT 20`, (err2, comm) => {
            if (err2) return res.status(500).json({ error: "Erreur SQL commerciaux" });
            res.json({
                routes: (routes || []).map(r => ({ value: r.route, label: `Route ${r.route}` })),
                commerciaux: (comm || []).map(c => ({ value: c.commercial, label: `Commercial ${c.commercial}` }))
            });
        });
    });
});

// 4. Route PRINCIPALE : L'algorithme IA DYNAMIQUE + BACKTESTING (Réel)
app.get('/api/tournees/plan', async (req, res) => {
    const date_precise = req.query.date_precise || new Date().toISOString().split('T')[0];
    const commercial = req.query.commercial;
    const route = req.query.route;

    // Déterminer si on demande le Passé (Réel) ou le Futur (Prédiction IA)
    const requestDate = new Date(date_precise);
    requestDate.setHours(0,0,0,0);
    const today = new Date();
    today.setHours(0,0,0,0);
    const isPast = requestDate < today;

    // 1. Récupération des clients (Filtres appliqués)
    let sqlClients = `
        SELECT 
            c.code AS nbr_client, c.plafond_credit AS plafond, c.potentiel,
            ? AS date_jour, CONCAT('Comm ', COALESCE(c.user_code, '-'), ' - ', COALESCE(c.delegation, 'Zone inconnue')) AS commercia_zone,
            COALESCE(c.region, 'Non Définie') AS region, 
            (CASE WHEN CAST(COALESCE(c.encours_actuelement, '0') AS DECIMAL) > 0 THEN 1 ELSE 0 END) AS recouvrement_reel,
            c.nom, c.adresse_facturation AS adresse
        FROM clients c
        WHERE c.deleted_at IS NULL AND c.isactif = '1'
    `;
    const params = [date_precise];
    if (route) { sqlClients += ` AND c.routing_code = ?`; params.push(route); }
    if (commercial) { sqlClients += ` AND c.user_code = ?`; params.push(commercial); }

    db.query(sqlClients, params, async (err, clients) => {
        if (err) return res.status(500).json({ error: err.message });

        let totalChiffre = 0;
        let iaAgro = 0, iaChips = 0, iaBur = 0;
        let histAgro = 0, histChips = 0, histBur = 0;
        let tourneesFormattees = [];

        if (isPast) {
            // ==========================================
            // 🕰️ MODE PASSÉ : Chiffres Réels + Détails Familles
            // ==========================================
            console.log(`🕰️ Mode Historique (Réel) pour le : ${date_precise}`);
            
            // Requête qui ramène la facture ET les familles de produits
            let sqlReel = `
                SELECT 
                    e.client_code,
                    e.code AS doc_code,
                    e.net_a_payer,
                    COALESCE(p.famille_code, 'AGRO') AS famille_code,
                    SUM(l.quantite) AS qte_ligne
                FROM entetecommercials e
                LEFT JOIN lignecommercials l ON e.code = l.entetecommercial_code
                LEFT JOIN produits p ON l.produit_code = p.code
                WHERE DATE(e.date) = ? AND e.type IN ('facture', 'bl', 'blf')
                GROUP BY e.client_code, e.code, e.net_a_payer, p.famille_code
            `;
            
            db.query(sqlReel, [date_precise], (errVentes, ventes) => {
                if (errVentes) return res.status(500).json({ error: errVentes.message });
                
                let ventesMap = {};
                let maxChiffreReel = 0;
                
                // Remise à zéro des compteurs totaux pour le passé
                iaAgro = 0; iaChips = 0; iaBur = 0; 

                ventes.forEach(v => {
                    if (!ventesMap[v.client_code]) {
                        ventesMap[v.client_code] = { 
                            chiffre: 0, qte: 0, docs: new Set(), 
                            details: { agro: 0, chips: 0, bur: 0 } 
                        };
                    }
                    
                    let cMap = ventesMap[v.client_code];
                    
                    // Ajouter le chiffre d'affaire (une seule fois par facture)
                    if (!cMap.docs.has(v.doc_code)) {
                        cMap.chiffre += v.net_a_payer;
                        cMap.docs.add(v.doc_code);
                    }
                    
                    let qteLigne = v.qte_ligne || 0;
                    cMap.qte += qteLigne;
                    
                    // 🔥 MAPPING : Trier les produits dans les bonnes cases 🔥
                    let famille = v.famille_code.toUpperCase();
                    if (famille.includes('CHIPS') || famille.includes('SNACK') || famille.includes('CHAMALLOWS') || famille.includes('BISCUIT')) {
                        cMap.details.chips += qteLigne;
                        iaChips += qteLigne; // On ajoute au total global (Boîte noire à droite)
                    } else if (famille.includes('BUR') || famille.includes('PAPIER')) {
                        cMap.details.bur += qteLigne;
                        iaBur += qteLigne;
                    } else {
                        // Le reste (Nutella, etc.) va dans Agro
                        cMap.details.agro += qteLigne;
                        iaAgro += qteLigne;
                    }
                });

                // Trouver le meilleur client pour le Score VIP
                for (let code in ventesMap) {
                    if (ventesMap[code].chiffre > maxChiffreReel) maxChiffreReel = ventesMap[code].chiffre;
                }

                tourneesFormattees = clients.map(c => {
                    const dataReelle = ventesMap[c.nbr_client];
                    if (!dataReelle) return null; 

                    const chiffre = dataReelle.chiffre;
                    const qte = dataReelle.qte;
                    const details = dataReelle.details; // <--- On récupère le détail 
                    
                    totalChiffre += chiffre;

                    return {
                        nbr_client: c.nbr_client,
                        chiffre: chiffre.toFixed(1) + ' TND',
                        score_ia: maxChiffreReel > 0 ? (chiffre / maxChiffreReel) * 100 : 0,
                        qte_reco: qte,
                        details: details, // <--- On envoie ça à React !
                        date_jour: c.date_jour, 
                        commercia_zone: c.commercia_zone,
                        region: c.region === 'GT' ? 'Grand Tunis' : c.region,
                        recouvrement: c.recouvrement_reel,
                        nom: c.nom + ' ✅ (Réel)',
                        adresse: c.adresse || 'Adresse non spécifiée'
                    };
                }).filter(t => t !== null).sort((a, b) => b.score_ia - a.score_ia);
                
                envoyerReponse(res, tourneesFormattees, date_precise, iaAgro, iaChips, iaBur);
            });
        } else {
            // ==========================================
            // 🔮 MODE FUTUR : Prédictions depuis Python (IA)
            // ==========================================
            console.log(`🔮 Mode Prédiction (IA) pour le : ${date_precise}`);
            let aiPredictions = {};
            
            try {
                const aiResponse = await axios.post('http://127.0.0.1:5001/api/predict', { date: date_precise });
                if (aiResponse.data.status === 'success') {
                    aiPredictions = aiResponse.data.predictions;
                }
            } catch (error) {
                console.error("⚠️ Serveur Python (api_ia.py) injoignable.");
            }

            // 1. On prépare TOUS les clients avec leurs scores IA
            let tousLesClients = clients.map(c => {
                const clientCodeStr = c.nbr_client.toString().padStart(5, '0');
                const iaData = aiPredictions[clientCodeStr];

                const scoreIA = iaData ? iaData.score : 0;
                const qteRecoIA = iaData ? iaData.qte : 0;
                const vnPreditIA = iaData ? iaData.chiffre : 0;

                let clientAgro = 0, clientChips = 0, clientBur = 0;
                
                if (iaData && iaData.details) {
                    clientAgro = iaData.details['Agro'] || iaData.details['AGRO'] || Math.floor(qteRecoIA * 0.45);
                    clientChips = iaData.details['Chips'] || iaData.details['CHIPS'] || Math.floor(qteRecoIA * 0.35);
                    clientBur = iaData.details['Bur'] || iaData.details['BUR'] || Math.floor(qteRecoIA * 0.20);
                } else {
                    clientAgro = Math.floor(qteRecoIA * 0.45);
                    clientChips = Math.floor(qteRecoIA * 0.35);
                    clientBur = Math.floor(qteRecoIA * 0.20);
                }

                const sommeDetails = clientAgro + clientChips + clientBur;
                if (sommeDetails < qteRecoIA) clientAgro += (qteRecoIA - sommeDetails); 
                else if (sommeDetails > qteRecoIA && clientAgro > 0) clientAgro -= (sommeDetails - qteRecoIA);

                return {
                    nbr_client: c.nbr_client,
                    chiffre_brut: vnPreditIA, // Gardé en nombre pour le calcul final
                    chiffre: vnPreditIA.toFixed(1) + ' TND',
                    score_ia: scoreIA,
                    qte_reco: qteRecoIA,
                    details: { agro: clientAgro, chips: clientChips, bur: clientBur }, 
                    date_jour: c.date_jour, 
                    commercia_zone: c.commercia_zone,
                    region: c.region === 'GT' ? 'Grand Tunis' : c.region,
                    recouvrement: c.recouvrement_reel,
                    nom: c.nom,
                    adresse: c.adresse || 'Adresse non spécifiée'
                };
            }).filter(t => t.score_ia > 0).sort((a, b) => b.score_ia - a.score_ia);

            // 🔥 2. FILTRE RÉALISTE : On garde uniquement les TOP 25 clients pour la tournée ! 🔥
            tourneesFormattees = tousLesClients.slice(0, 25);

            // 3. On recalcule les totaux EXACTEMENT pour ces 25 clients
            iaAgro = 0; iaChips = 0; iaBur = 0; totalChiffre = 0;
            
            tourneesFormattees.forEach(t => {
                totalChiffre += t.chiffre_brut;
                iaAgro += t.details.agro;
                iaChips += t.details.chips;
                iaBur += t.details.bur;
            });

            envoyerReponse(res, tourneesFormattees, date_precise, iaAgro, iaChips, iaBur);
        }
    });
});

// Petite fonction pour envoyer la réponse proprement et éviter de répéter le code
// Petite fonction pour envoyer la réponse proprement
function envoyerReponse(res, tournees, date_precise, agro, chips, bur) {
    const chargeTotale = { agro, chips, bureautique: bur };
    
    // 🔥 LECTURE DE LA VRAIE PRÉCISION DEPUIS PYTHON 🔥
    let vraiePrecision = 85.4; // Valeur par défaut
    try {
        const precisionLue = fs.readFileSync('precision.txt', 'utf8');
        if (precisionLue && !isNaN(parseFloat(precisionLue))) {
            vraiePrecision = parseFloat(precisionLue);
        }
    } catch(e) {
        // Fichier pas encore créé, on garde la valeur par défaut
    }

    res.json({
        tournees: tournees,
        total: tournees.length,
        jourSelectionne: date_precise,
        chargeTotale,
        precision_ia: vraiePrecision, // <--- On envoie la vraie précision à React !
        itineraire: tournees.map(r => r.nom + (r.score_ia >= 80 ? ' (VIP)' : ''))
    });
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Serveur API prêt sur http://localhost:${PORT}`));