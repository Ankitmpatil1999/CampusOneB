import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const tables = ['subjects', 'class_subjects', 'teacher_assignments'];
  for (const tbl of tables) {
    console.log(`\n=================== ${tbl} ===================`);
    const [cols]: any = await conn.query(`DESCRIBE campusone_cug.${tbl}`);
    console.table(cols.map((c: any) => ({ Field: c.Field, Type: c.Type, Null: c.Null, Key: c.Key, Default: c.Default })));
    
    const [rows]: any = await conn.query(`SELECT * FROM campusone_cug.${tbl} WHERE institution_id = 6 LIMIT 5`);
    console.log(`Rows in inst 6 (${rows.length}):`);
    console.log(rows);
  }

  await conn.end();
}

main().catch(console.error);
