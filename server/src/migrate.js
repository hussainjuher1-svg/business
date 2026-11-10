const { migrate, DB_PATH } = require('./db');
migrate();
console.log(`[db] migrations complete. Database: ${DB_PATH}`);
process.exit(0);
