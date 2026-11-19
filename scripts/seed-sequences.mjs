import mysql from 'mysql2/promise';

async function seedSequences() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  await conn.query(`
    INSERT INTO campusone_cug.wallet_number_sequences (kind, next_value) VALUES 
    ('CAMPUS', 555500001),
    ('ALLOWANCE', 565656000000001),
    ('PERSONAL', 888888800000001)
    ON DUPLICATE KEY UPDATE next_value = VALUES(next_value);
  `);
  const [rows] = await conn.query('SELECT * FROM campusone_cug.wallet_number_sequences');
  console.log('Seeded wallet_number_sequences:', rows);
  await conn.end();
}

seedSequences().catch(console.error);

