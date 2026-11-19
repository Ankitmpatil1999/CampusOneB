import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [sections]: any = await conn.query(`
    SELECT s.id, s.name as sec_name, c.name as class_name
    FROM campusone_cug.sections s
    JOIN campusone_cug.classes c ON c.id = s.class_id
    WHERE s.institution_id = 6
    ORDER BY s.id
  `);
  console.log('Sections:');
  console.table(sections);

  const [noSecStudents]: any = await conn.query(`
    SELECT mp.id, mp.first_name, mp.last_name, mp.department_id, d.name as dept_name, en.id as enrol_id, en.section_id
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    LEFT JOIN campusone_cug.departments d ON d.id = mp.department_id
    LEFT JOIN campusone_cug.enrolments en ON en.student_profile_id = mp.id AND en.year_id = 6
    WHERE mp.institution_id = 6 AND mp.status != 'INACTIVE' AND ut.category = 'STUDENT' AND en.section_id IS NULL
  `);
  console.log('Students without section:');
  console.table(noSecStudents);

  await conn.end();
}

main().catch(console.error);
