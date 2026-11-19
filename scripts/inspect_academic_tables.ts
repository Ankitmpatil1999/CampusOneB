import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [tables]: any = await conn.query("SHOW TABLES FROM campusone_cug");
  const allTableNames = tables.map((t: any) => Object.values(t)[0] as string);
  
  const examTables = allTableNames.filter(t => t.includes('exam') || t.includes('mark') || t.includes('grade') || t.includes('result'));
  const timetableTables = allTableNames.filter(t => t.includes('time') || t.includes('period') || t.includes('slot') || t.includes('schedule'));
  const subjectTables = allTableNames.filter(t => t.includes('sub') || t.includes('course') || t.includes('teach'));
  const sectionTables = allTableNames.filter(t => t.includes('sec') || t.includes('class'));

  console.log('Exam/Mark tables:', examTables);
  console.log('Timetable tables:', timetableTables);
  console.log('Subject/Teacher tables:', subjectTables);
  console.log('Section/Class tables:', sectionTables);

  await conn.end();
}

main().catch(console.error);
