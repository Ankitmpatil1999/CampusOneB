import mysql from 'mysql2/promise';

async function updateName() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  await conn.query('UPDATE campusone.platform_accounts SET first_name = ?, last_name = ? WHERE id = 9', [
    'Ankit',
    'Patil'
  ]);
  const [rows] = await conn.query('SELECT id, email, first_name, last_name, mobile FROM campusone.platform_accounts WHERE id = 9');
  console.log('SUCCESS: Updated Super Admin account:', rows[0]);
  await conn.end();
}

updateName().catch(console.error);

