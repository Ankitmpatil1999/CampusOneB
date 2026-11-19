import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [tables]: any = await conn.query("SHOW TABLES FROM campusone");
  console.log('Tables in campusone DB:');
  console.table(tables.map((t: any) => Object.values(t)[0]));
  await conn.end();
}

main().catch(console.error);
