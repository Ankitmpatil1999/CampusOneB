import mysql from 'mysql2/promise';

async function checkAccount() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [acc]: any = await conn.query('SELECT id, public_id, email, first_name, last_name FROM campusone.platform_accounts WHERE id IN (1079, 1080, 1128)');
  console.log('Platform Accounts:');
  console.table(acc);
  await conn.end();
}

checkAccount().catch(console.error);
