import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [rows]: any = await conn.query('SELECT id, exam_name_id, section_id, subject_id, live_key FROM campusone_cug.exams LIMIT 10');
  console.table(rows);
  await conn.end();
}

main().catch(console.error);
