import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [fks]: any = await conn.query(`
    SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = 'campusone_cug' AND TABLE_NAME = 'attendance_days' AND REFERENCED_TABLE_NAME IS NOT NULL
  `);
  console.log('Foreign keys on attendance_days:');
  console.table(fks);

  const [triggers]: any = await conn.query(`
    SHOW TRIGGERS FROM campusone_cug LIKE 'attendance_days'
  `);
  console.log('Triggers on attendance_days:', triggers.map((t: any) => t.Trigger));

  await conn.end();
}

main().catch(console.error);
