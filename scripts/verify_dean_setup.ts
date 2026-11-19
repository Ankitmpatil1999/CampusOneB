import mysql from 'mysql2/promise';

async function testDeanAPIs() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  // 1. Verify Dean account & credential
  const [acc]: any = await conn.query(`
    SELECT pa.id, pa.email, pa.mobile, pa.first_name, pa.last_name, pa.status
    FROM campusone.platform_accounts pa
    WHERE pa.email = 'dean@pbcoe.edu.in'
  `);
  console.log('✅ Dean Platform Account:', acc[0]);

  // 2. Verify Member Profile & User Type
  const [prof]: any = await conn.query(`
    SELECT mp.id, mp.institution_id, mp.first_name, mp.last_name, ut.name as user_type, ut.category
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE mp.account_id = ? AND mp.institution_id = 6
  `, [acc[0].id]);
  console.log('✅ Dean Member Profile:', prof[0]);

  // 3. Verify Roles
  const [roles]: any = await conn.query(`
    SELECT r.id, r.code, r.name
    FROM campusone_cug.profile_roles pr
    JOIN campusone.roles r ON r.id = pr.role_id
    WHERE pr.profile_id = ?
  `, [prof[0].id]);
  console.log('✅ Dean Assigned Roles:', roles);

  // 4. Verify Granted Tasks & Subtasks
  const [tasks]: any = await conn.query(`
    SELECT DISTINCT t.code as task_code, st.code as sub_task_code
    FROM campusone_cug.profile_roles pr
    JOIN campusone.role_tasks rt ON rt.role_id = pr.role_id
    JOIN campusone.sub_tasks st ON st.id = rt.sub_task_id
    JOIN campusone.tasks t ON t.id = st.task_id
    WHERE pr.profile_id = ?
    ORDER BY t.code, st.code
  `, [prof[0].id]);
  
  const groupedTasks: Record<string, string[]> = {};
  for (const t of tasks) {
    if (!groupedTasks[t.task_code]) groupedTasks[t.task_code] = [];
    groupedTasks[t.task_code].push(t.sub_task_code);
  }
  console.log('\n--- DEAN ACCESS PERMISSIONS (GROUPED) ---');
  for (const [task, sub] of Object.entries(groupedTasks)) {
    console.log(`📌 ${task.toUpperCase().padEnd(14)}: ${sub.join(', ')}`);
  }

  // 5. Verify User Type in Management (Console User Types)
  const [userTypes]: any = await conn.query(`
    SELECT id, name, category, status 
    FROM campusone_cug.user_types 
    WHERE institution_id = 6 AND category = 'DEAN'
  `);
  console.log('\n✅ PBCOE Management User Type for Dean:', userTypes);

  await conn.end();
}

testDeanAPIs().catch(console.error);
