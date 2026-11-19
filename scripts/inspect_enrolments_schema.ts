import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [cols]: any = await conn.query('DESCRIBE campusone_cug.enrolments');
  console.table(cols);

  const [sample]: any = await conn.query('SELECT * FROM campusone_cug.enrolments WHERE institution_id = 6 LIMIT 1');
  console.log('Sample enrolment in inst 6:');
  console.log(sample[0]);

  await conn.end();
}

main().catch(console.error);
