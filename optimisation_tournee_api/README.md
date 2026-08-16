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

