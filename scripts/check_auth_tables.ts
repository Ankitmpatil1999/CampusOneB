import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [tables]: any = await conn.query("SHOW TABLES FROM campusone_cug LIKE '%user%'");
  const [authTables]: any = await conn.query("SHOW TABLES FROM campusone_cug LIKE '%auth%'");
  const [accountTables]: any = await conn.query("SHOW TABLES FROM campusone_cug LIKE '%account%'");
  console.log('User tables:', tables);
  console.log('Auth tables:', authTables);
  console.log('Account tables:', accountTables);

  const [cols]: any = await conn.query("DESCRIBE campusone_cug.member_profiles");
  console.log('member_profiles cols:', cols.map((c: any) => c.Field));
  await conn.end();
}

main().catch(console.error);
