const fs = require('fs');
const { Client } = require('pg');
require('dotenv').config();

(async () => {
  const sql = fs.readFileSync(__dirname + '/schema.sql', 'utf8');
  const client = new Client({ connectionString: process.env.PG_URL });
  await client.connect();
  await client.query(sql);
  await client.end();
  console.log('DB migrated.');
})().catch(e => { console.error(e); process.exit(1); });
