import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [indexes]: any = await conn.query('SHOW INDEX FROM campusone_cug.calendar_entries');
  console.table(indexes.map((i: any) => ({ Key_name: i.Key_name, Column_name: i.Column_name, Non_unique: i.Non_unique })));
  
  const [annIndexes]: any = await conn.query('SHOW INDEX FROM campusone_cug.announcements');
  console.table(annIndexes.map((i: any) => ({ Key_name: i.Key_name, Column_name: i.Column_name, Non_unique: i.Non_unique })));

  await conn.end();
}

main().catch(console.error);
