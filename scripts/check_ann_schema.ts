import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [cats]: any = await conn.query('SELECT * FROM campusone_cug.announcement_categories');
  console.log('Announcement categories:');
  console.table(cats);

  const [cols]: any = await conn.query('DESCRIBE campusone_cug.announcements');
  console.log('Announcements cols:');
  console.table(cols.map((c: any) => ({ Field: c.Field, Type: c.Type, Null: c.Null, Default: c.Default })));

  await conn.end();
}

main().catch(console.error);
