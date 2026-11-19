import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  // 1. Classes and sections
  const [classes]: any = await conn.query(`
    SELECT c.id as class_id, c.name as class_name, s.id as section_id, s.name as sec_name,
           (SELECT COUNT(*) FROM campusone_cug.enrolments en WHERE en.section_id = s.id AND en.year_id = 6) as student_count
    FROM campusone_cug.classes c
    JOIN campusone_cug.sections s ON s.class_id = c.id
    WHERE c.institution_id = 6
    ORDER BY c.id, s.id
  `);
  console.log('Classes & Sections in PBCOE:');
  console.table(classes);

  // 2. Existing subjects
  const [subjects]: any = await conn.query(`
    SELECT id, code, name, colour FROM campusone_cug.subjects WHERE institution_id = 6
  `);
  console.log('Existing Subjects in PBCOE:');
  console.table(subjects);

  // 3. Existing class subjects
  const [classSubjects]: any = await conn.query(`
    SELECT cs.class_id, c.name as class_name, cs.subject_id, s.name as subject_name, s.code
    FROM campusone_cug.class_subjects cs
    JOIN campusone_cug.classes c ON c.id = cs.class_id
    JOIN campusone_cug.subjects s ON s.id = cs.subject_id
    WHERE cs.institution_id = 6
  `);
  console.log('Existing Class Subjects in PBCOE:');
  console.table(classSubjects);

  // 4. Existing teacher assignments
  const [assignments]: any = await conn.query(`
    SELECT ta.id, ta.kind, ta.teacher_profile_id, mp.first_name, mp.last_name, 
           c.name as class_name, s.name as sec_name, sub.name as subject_name
    FROM campusone_cug.teacher_assignments ta
    JOIN campusone_cug.member_profiles mp ON mp.id = ta.teacher_profile_id
    LEFT JOIN campusone_cug.classes c ON c.id = ta.class_id
    LEFT JOIN campusone_cug.sections s ON s.id = ta.section_id
    LEFT JOIN campusone_cug.subjects sub ON sub.id = ta.subject_id
    WHERE ta.institution_id = 6 AND ta.ended_at IS NULL
  `);
  console.log('Existing Teacher Assignments in PBCOE:');
  console.table(assignments);

  // 5. Existing periods
  const [periods]: any = await conn.query(`
    SELECT * FROM campusone_cug.periods WHERE institution_id = 6
  `);
  console.log('Existing Periods in PBCOE:', periods);

  // 6. Existing timetable slots
  const [slots]: any = await conn.query(`
    SELECT * FROM campusone_cug.timetable_slots WHERE institution_id = 6 LIMIT 5
  `);
  console.log('Existing Timetable Slots in PBCOE:', slots);

  await conn.end();
}

main().catch(console.error);
