/**
 * Configuration PM2 pour Nomadis.
 *
 * PM2 gere: redemarrage automatique en cas de crash, redemarrage si fuite
 * memoire, rotation des logs, arret propre (SIGINT/SIGTERM) et demarrage au boot.
 *
 * Usage:
 *   npm install                      # installe pm2 (devDependency)
 *   npx pm2 start ecosystem.config.cjs
 *   npx pm2 status
 *   npx pm2 logs
 *   npx pm2 restart nomadis-api
 *   npx pm2 reload all               # reload sans downtime
 *   npx pm2 stop all
 *   npx pm2 save                     # fige la liste des process
 *   npx pm2 startup                  # genere le script de demarrage au boot (Linux)
 *
 * Sous Windows, remplacer l'interpreteur Python si besoin: PYTHON_BIN=python3
 */

const path = require('path')

const PYTHON_BIN = process.env.PYTHON_BIN || 'python'
const logDir = path.join(__dirname, 'logs')

module.exports = {
  apps: [
    {
      name: 'nomadis-api',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork', // caches en memoire + schedulers => pas de mode cluster
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      max_memory_restart: '1G',
      kill_timeout: 11000, // > au delai de grace (10s) cote server.js
      wait_ready: false,
      listen_timeout: 10000,
      time: true,
      merge_logs: true,
      out_file: path.join(logDir, 'nomadis-api.out.log'),
      error_file: path.join(logDir, 'nomadis-api.err.log'),
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'nomadis-ai',
      script: 'api_ia.py',
      interpreter: PYTHON_BIN,
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s', // le chargement des modeles peut prendre du temps
      restart_delay: 3000,
      max_memory_restart: '2G',
      kill_timeout: 10000,
      time: true,
      merge_logs: true,
      out_file: path.join(logDir, 'nomadis-ai.out.log'),
      error_file: path.join(logDir, 'nomadis-ai.err.log'),
      env: {
        FLASK_DEBUG: 'False',
        FLASK_HOST: '127.0.0.1',
        FLASK_PORT: '5001'
      }
    }
  ]
}
