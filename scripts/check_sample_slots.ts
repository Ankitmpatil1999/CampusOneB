import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [rows]: any = await conn.query('SELECT * FROM campusone_cug.timetable_slots LIMIT 5');
  console.log('Sample timetable_slots:');
  console.table(rows);
  await conn.end();
}

main().catch(console.error);
