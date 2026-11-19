import mysql from 'mysql2/promise';

async function checkAttendanceTables() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [tables]: any = await conn.query("SHOW TABLES FROM campusone_cug LIKE '%att%'");
  console.log('Attendance tables in campusone_cug:');
  console.table(tables);

  const [sampleDays]: any = await conn.query('SELECT * FROM campusone_cug.attendance_days WHERE institution_id = 6 LIMIT 5');
  console.log('Sample rows in attendance_days:');
  console.table(sampleDays);

  const [uniqueProfiles]: any = await conn.query(`
    SELECT ut.category, COUNT(DISTINCT ad.profile_id) as count
    FROM campusone_cug.attendance_days ad
    JOIN campusone_cug.member_profiles mp ON mp.id = ad.profile_id
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE ad.institution_id = 6
    GROUP BY ut.category
  `);
  console.log('Existing attendance profiles by category:');
  console.table(uniqueProfiles);

  await conn.end();
}

checkAttendanceTables().catch(console.error);
