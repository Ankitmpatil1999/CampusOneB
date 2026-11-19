import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const tables = [
    'campusone_cug.calendar_entries',
    'campusone_cug.calendar_entry_targets',
    'campusone_cug.events',
    'campusone_cug.event_heads',
    'campusone_cug.announcement_categories',
    'campusone_cug.announcements',
    'campusone_cug.announcement_recipients',
    'campusone.notifications'
  ];

  for (const tbl of tables) {
    console.log(`\n=================== ${tbl} ===================`);
    const [cols]: any = await conn.query(`DESCRIBE ${tbl}`);
    console.table(cols.map((c: any) => ({ Field: c.Field, Type: c.Type, Null: c.Null, Key: c.Key, Default: c.Default })));
    
    const [samples]: any = await conn.query(`SELECT * FROM ${tbl} LIMIT 3`);
    console.log('Sample rows:', samples);
  }

  await conn.end();
}

main().catch(console.error);
