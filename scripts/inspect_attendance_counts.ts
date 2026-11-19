import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [students]: any = await conn.query(`
    SELECT COUNT(*) as total_students,
           COUNT(en.section_id) as with_section,
           COUNT(DISTINCT en.section_id) as distinct_sections
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    LEFT JOIN campusone_cug.enrolments en ON en.student_profile_id = mp.id AND en.year_id = 6
    WHERE mp.institution_id = 6 AND mp.status != 'INACTIVE' AND ut.category = 'STUDENT'
  `);
  console.log('Students:', students);

  const [staff]: any = await conn.query(`
    SELECT ut.category, COUNT(*) as count
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE mp.institution_id = 6 AND mp.status != 'INACTIVE' AND ut.category != 'STUDENT'
    GROUP BY ut.category
  `);
  console.log('Staff/Faculty by category:');
  console.table(staff);

  const [existingAtt]: any = await conn.query(`
    SELECT MIN(att_date) as min_date, MAX(att_date) as max_date, COUNT(*) as total_records
    FROM campusone_cug.attendance_days
    WHERE institution_id = 6
  `);
  console.log('Existing attendance in inst 6:', existingAtt);

  await conn.end();
}

main().catch(console.error);
