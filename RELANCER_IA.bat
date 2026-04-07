@echo off
REM Script de mise à jour rapide de l'IA - Nomadis
REM Double-cliquez sur ce fichier pour relancer l'IA

color 0A
title Mise a jour IA - Nomadis
echo.
echo ============================================================
echo  MISE A JOUR DE L'IA - Nomadis
echo ============================================================
echo.

REM Aller dans le dossier de l'API
cd /d "%~dp0optimisation_tournee_api"

if not exist "train_auto.py" (
    echo ERROR: Fichier train_auto.py non trouve!
    echo Assurez-vous d'etre dans le bon repertoire.
    pause
    exit /b 1
)

echo.
echo [1/3] Verification des donnees...
python verify_data.py
echo.

echo [2/3] Entrainement de l'IA en cours (cela peut prendre 1-2 minutes)...
python train_auto.py

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ============================================================
    echo  SUCCESS - L'IA a ete mise a jour avec succes!
    echo ============================================================
    echo.
    echo Les fichiers generes:
    echo  - modele_nomadis.pkl
    echo  - colonnes_ia.pkl
    echo  - precision.txt
    echo  - master_dataset_v3.csv
    echo  - preferences_clients_produits.csv
    echo.
    echo PROCHAINE ETAPE: Relancer le serveur Node.js
    echo   node server.js
    echo.
) else (
    echo.
    echo ============================================================
    echo  ERREUR - L'entrainement a echoue
    echo ============================================================
    echo.
    echo Assurez-vous que:
    echo  1. MySQL/XAMPP est lance et fonctionne
    echo  2. La base 'dist_utic' existe
    echo  3. Python 3.8+ est installe
    echo  4. Les dependances sont installees: pip install -r requirements.txt
    echo.
)

pause
