import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [needed]: any = await conn.query(`
    SELECT s.id as section_id, s.name as sec_name, c.id as class_id, c.name as class_name, cs.subject_id, sub.name as subject_name
    FROM campusone_cug.sections s
    JOIN campusone_cug.classes c ON c.id = s.class_id
    JOIN campusone_cug.class_subjects cs ON cs.class_id = c.id
    JOIN campusone_cug.subjects sub ON sub.id = cs.subject_id
    WHERE s.institution_id = 6
  `);
  console.log(`Total (section, subject) pairs: ${needed.length}`);

  const [assigned]: any = await conn.query(`
    SELECT ta.section_id, ta.subject_id, ta.teacher_profile_id
    FROM campusone_cug.teacher_assignments ta
    WHERE ta.institution_id = 6 AND ta.kind = 'SUBJECT_TEACHER' AND ta.ended_at IS NULL
  `);
  console.log(`Current active SUBJECT_TEACHER assignments: ${assigned.length}`);

  await conn.end();
}

main().catch(console.error);
