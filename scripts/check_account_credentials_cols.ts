import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [cols]: any = await conn.query('DESCRIBE campusone.account_credentials');
  console.table(cols.map((c: any) => ({ Field: c.Field, Type: c.Type })));

  const [sample]: any = await conn.query('SELECT * FROM campusone.account_credentials WHERE account_id = 1083');
  console.log('Sample for account 1083 (Dean):', sample);

  await conn.end();
}

main().catch(console.error);
