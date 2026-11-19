import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [rows]: any = await conn.query(`
    SELECT ta.id, ta.section_id, s.name as sec_name, c.name as class_name, ta.teacher_profile_id, mp.first_name, mp.last_name
    FROM campusone_cug.teacher_assignments ta
    JOIN campusone_cug.member_profiles mp ON mp.id = ta.teacher_profile_id
    JOIN campusone_cug.sections s ON s.id = ta.section_id
    JOIN campusone_cug.classes c ON c.id = ta.class_id
    WHERE ta.institution_id = 6 AND ta.kind = 'CLASS_TEACHER' AND ta.ended_at IS NULL
  `);
  console.log(`Active CLASS_TEACHER assignments in inst 6: ${rows.length}`);
  console.table(rows);
  await conn.end();
}

main().catch(console.error);
