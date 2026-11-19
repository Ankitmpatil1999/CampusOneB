import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  // 1. Check subtasks for HOD role (27)
  const [hodSubtasks]: any = await conn.query(`
    SELECT rt.role_id, st.id, st.code
    FROM campusone.role_tasks rt
    JOIN campusone.sub_tasks st ON st.id = rt.sub_task_id
    WHERE rt.role_id = 27
  `);
  console.log('HOD role (27) subtasks:', hodSubtasks.map((s: any) => s.code));

  // 2. Fetch all faculty profiles in PBCOE
  const [faculty]: any = await conn.query(`
    SELECT mp.id, mp.first_name, mp.last_name, ut.category
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE mp.institution_id = 6 AND ut.category = 'TEACHER'
  `);
  console.log(`Found ${faculty.length} teachers in PBCOE:`);
  console.table(faculty);

  // 3. Ensure all faculty members have role_id = 2 ('Teacher') in profile_roles
  for (const f of faculty) {
    await conn.query(`
      INSERT IGNORE INTO campusone_cug.profile_roles (institution_id, profile_id, role_id)
      VALUES (6, ?, 2)
    `, [f.id]);
  }
  console.log('✅ Ensured role_id = 2 (Teacher) is assigned to all PBCOE faculty!');

  // Also check role 27 (HOD) — add teaching subtasks to HOD if missing
  const teachingSubTaskCodes = [
    'teaching.view',
    'teaching.attendance',
    'teaching.marks',
    'teaching.homework',
    'teaching.leave',
    'teaching.timetable',
    'teaching.announce'
  ];
  const [tSubTasks]: any = await conn.query("SELECT id FROM campusone.sub_tasks WHERE code IN (?)", [teachingSubTaskCodes]);
  for (const st of tSubTasks) {
    await conn.query("INSERT IGNORE INTO campusone.role_tasks (role_id, sub_task_id) VALUES (27, ?)", [st.id]);
  }
  console.log('✅ Ensured teaching subtasks are also present on HOD role (27)!');

  await conn.end();
}

main().catch(console.error);
