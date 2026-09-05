# Optimisation Tournee API

## Commandes utiles

### 1. Installer les dependances Python

```powershell
cd C:\Users\asus\Desktop\Projet_Nomadis\optimisation_tournee_api
python -m pip install -r requirements.txt
```

### 2. Installer OR-Tools seulement

```powershell
cd C:\Users\asus\Desktop\Projet_Nomadis\optimisation_tournee_api
python -m pip install ortools==9.10.4067
```

### 3. Installer les dependances Node.js

```powershell
cd C:\Users\asus\Desktop\Projet_Nomadis\optimisation_tournee_api
npm install
```

### 4. Lancer l'API Python IA / OR-Tools

```powershell
cd C:\Users\asus\Desktop\Projet_Nomadis\optimisation_tournee_api
python api_ia.py
```

L'API Python tourne sur `http://127.0.0.1:5001`.

### 5. Lancer le serveur Node.js

```powershell
cd C:\Users\asus\Desktop\Projet_Nomadis\optimisation_tournee_api
node server.js
```

Le serveur Node tourne sur `http://127.0.0.1:5000`.

### 6. Verifier rapidement que OR-Tools est bien installe

```powershell
python -c "import ortools; print(ortools.__version__)"
```

### 7. Ordre de demarrage conseille

```powershell
cd C:\Users\asus\Desktop\Projet_Nomadis\optimisation_tournee_api
python api_ia.py
```

Dans un deuxieme terminal :

```powershell
cd C:\Users\asus\Desktop\Projet_Nomadis\optimisation_tournee_api
node server.js
```

## Exploitation (process manager + healthchecks)

Lancer les deux services a la main n'est pas fiable : rien ne les relance en cas
de crash. En dev comme en prod, utiliser un gestionnaire de process.

### Healthchecks

| Service | Liveness | Readiness |
| --- | --- | --- |
| API Node (5000) | `GET /health` | `GET /health/ready` (ping MySQL + etat API IA) |
| API IA (5001) | `GET /health` | `GET /health/ready` (modeles charges) |

`GET /health/ready` renvoie `503` si la dependance critique est KO (utilisable
par un load balancer ou une sonde).

Script tout-en-un : `sh deploy/healthcheck.sh` (code retour 0 = OK).

### Option A - PM2 (Windows + Linux)

```powershell
npm install                       # installe pm2 (devDependency)
npx pm2 start ecosystem.config.cjs
npx pm2 status
npx pm2 logs
npx pm2 reload all                # reload sans downtime
npx pm2 save                      # fige la liste
npx pm2 startup                   # demarrage au boot (Linux)
```

PM2 relance automatiquement un process qui crash, le redemarre en cas de fuite
memoire (`max_memory_restart`) et centralise les logs dans `logs/`.

### Option B - systemd (prod Linux)

Fichiers dans `deploy/` :

```bash
sudo cp deploy/nomadis-ai.service deploy/nomadis-api.service /etc/systemd/system/
# adapter User / WorkingDirectory / chemins node & python
sudo systemctl daemon-reload
sudo systemctl enable --now nomadis-ai nomadis-api
journalctl -u nomadis-api -f
```

`Restart=always` relance les services en cas de crash ; l'arret propre
(SIGTERM) est gere par le serveur (fermeture du pool MySQL, delai de grace 10s).

