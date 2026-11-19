import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [cugTables]: any = await conn.query("SHOW TABLES FROM campusone_cug");
  const cugNames = cugTables.map((t: any) => Object.values(t)[0] as string);
  
  const [platformTables]: any = await conn.query("SHOW TABLES FROM campusone");
  const platformNames = platformTables.map((t: any) => Object.values(t)[0] as string);

  console.log('campusone_cug relevant tables:');
  console.log(cugNames.filter(t => t.includes('event') || t.includes('cal') || t.includes('hol') || t.includes('not') || t.includes('ann')));

  console.log('campusone relevant tables:');
  console.log(platformNames.filter(t => t.includes('event') || t.includes('cal') || t.includes('hol') || t.includes('not') || t.includes('ann')));

  await conn.end();
}

main().catch(console.error);
