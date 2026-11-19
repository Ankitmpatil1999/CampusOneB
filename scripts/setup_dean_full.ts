import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');

  console.log('--- ALL INSTITUTION TASKS ---');
  const [tasks]: any = await conn.query("SELECT id, code, label_key FROM campusone.tasks WHERE scope = 'INSTITUTION'");
  console.table(tasks);

  // Dean Role ID is 30
  const deanRoleId = 30;

  // Let's grant Dean comprehensive Academic, Student, People, and Administrative tasks:
  // Home, Reports, Members, Admissions, Academics, Leave, Attendance, Frontdesk, Comms, Approvals, Grievances, Principal, Teaching
  const deanTaskCodes = [
    'home',
    'reports',
    'members',
    'cards',
    'admissions',
    'academics',
    'leave',
    'attendance',
    'frontdesk',
    'comms',
    'approvals',
    'grievances',
    'principal',
    'teaching'
  ];

  const targetTaskIds = tasks.filter((t: any) => deanTaskCodes.includes(t.code)).map((t: any) => t.id);
  console.log('Target Task IDs for Dean:', targetTaskIds);

  // 1. Assign to role_task_assignments
  for (const tid of targetTaskIds) {
    await conn.query('INSERT IGNORE INTO campusone.role_task_assignments (role_id, task_id) VALUES (?, ?)', [deanRoleId, tid]);
  }
  console.log('✅ Updated role_task_assignments for DEAN');

  // 2. Assign all subtasks of these tasks to role_tasks
  const [subtasks]: any = await conn.query('SELECT id, task_id, code FROM campusone.sub_tasks WHERE task_id IN (?)', [targetTaskIds]);
  for (const st of subtasks) {
    await conn.query('INSERT IGNORE INTO campusone.role_tasks (role_id, sub_task_id) VALUES (?, ?)', [deanRoleId, st.id]);
  }
  console.log(`✅ Assigned ${subtasks.length} subtasks to role_tasks for DEAN`);

  // 3. Make sure Pravin Patil (profile 1109) has role 30, and also add role 8 (Academic Coordinator) and 28 (Principal Assistant) for backup
  await conn.query('INSERT IGNORE INTO campusone_cug.profile_roles (institution_id, profile_id, role_id, created_at) VALUES (6, 1109, 30, NOW(3))');
  await conn.query('INSERT IGNORE INTO campusone_cug.profile_roles (institution_id, profile_id, role_id, created_at) VALUES (6, 1109, 8, NOW(3))');
  await conn.query('INSERT IGNORE INTO campusone_cug.profile_roles (institution_id, profile_id, role_id, created_at) VALUES (6, 1109, 28, NOW(3))');
  console.log('✅ Pravin Patil profile_roles confirmed');

  // 4. Verify what session subTasks Pravin Patil receives
  console.log('\n--- VERIFYING GRANTED SUBTASKS FOR DEAN ---');
  const [granted]: any = await conn.query(`
    SELECT DISTINCT st.code
    FROM campusone_cug.profile_roles pr
    JOIN campusone.role_tasks rt ON rt.role_id = pr.role_id
    JOIN campusone.sub_tasks st ON st.id = rt.sub_task_id
    WHERE pr.profile_id = 1109
    ORDER BY st.code
  `);
  console.log(`Dean has ${granted.length} active granted subtasks:`, granted.map((g: any) => g.code).join(', '));

  await conn.end();
}

main().catch(console.error);
