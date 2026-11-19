import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [cols]: any = await conn.query('DESCRIBE campusone_cug.announcement_categories');
  console.table(cols);
  await conn.end();
}

main().catch(console.error);
