import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [cols]: any = await conn.query('DESCRIBE campusone_cug.marks');
  console.table(cols.map((c: any) => ({ Field: c.Field, Type: c.Type, Null: c.Null, Key: c.Key, Default: c.Default })));
  const [sample]: any = await conn.query('SELECT * FROM campusone_cug.marks WHERE exam_id IN (SELECT id FROM campusone_cug.exams WHERE institution_id = 6) LIMIT 3');
  console.log('Sample mark in inst 6:');
  console.log(sample);
  await conn.end();
}

main().catch(console.error);
