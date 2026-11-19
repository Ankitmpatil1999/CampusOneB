import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const tables = [
    'exam_names',
    'exams',
    'marks',
    'subjects',
    'class_subjects',
    'teacher_assignments',
    'timetable_slots',
    'periods',
    'sections'
  ];

  for (const tbl of tables) {
    console.log(`\n=================== ${tbl} ===================`);
    const [cols]: any = await conn.query(`DESCRIBE campusone_cug.${tbl}`);
    console.table(cols.map((c: any) => ({ Field: c.Field, Type: c.Type, Null: c.Null, Key: c.Key, Default: c.Default })));

    const [countRes]: any = await conn.query(`SELECT COUNT(*) as cnt FROM campusone_cug.${tbl} ${cols.some((c: any) => c.Field === 'institution_id') ? 'WHERE institution_id = 6' : ''}`);
    console.log(`Row count for inst 6: ${countRes[0].cnt}`);

    if (countRes[0].cnt > 0) {
      const [samples]: any = await conn.query(`SELECT * FROM campusone_cug.${tbl} ${cols.some((c: any) => c.Field === 'institution_id') ? 'WHERE institution_id = 6' : ''} LIMIT 3`);
      console.log('Sample rows:', samples);
    }
  }

  await conn.end();
}

main().catch(console.error);
