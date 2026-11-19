import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [subjects]: any = await conn.query('SELECT id, code, name, colour FROM campusone_cug.subjects WHERE institution_id = 6');
  console.log(`Total subjects in inst 6: ${subjects.length}`);
  console.table(subjects);
  await conn.end();
}

main().catch(console.error);
