const mysql = require('mysql2');
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'dist_utic'
});

db.connect(err => {
  if (err) {
    console.error('SQL connect error', err);
    process.exit(1);
  }
  db.query('SELECT code, nom, latitude, longitude FROM clients WHERE latitude IS NOT NULL OR longitude IS NOT NULL LIMIT 20', (err, rows) => {
    if (err) {
      console.error('Query error', err);
      process.exit(1);
    }
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  });
});
