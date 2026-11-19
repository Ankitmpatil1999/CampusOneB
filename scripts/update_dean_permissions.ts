import mysql from 'mysql2/promise';

async function updateDeanRoles() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const deanRoleId = 30;

  // 1. Remove inappropriate tasks from DEAN (teaching, fees, settlements, vouchers, gateways, corpcodes, merchants, allowances, coupons, transport)
  const forbiddenTasks = ['teaching', 'fees', 'admfees', 'settlements', 'vouchers', 'gateways', 'corpcodes', 'merchants', 'business', 'allowances', 'coupons', 'transport', 'readers'];
  
  const [fTasks]: any = await conn.query("SELECT id, code FROM campusone.tasks WHERE code IN (?)", [forbiddenTasks]);
  const fTaskIds = fTasks.map((t: any) => t.id);

  if (fTaskIds.length > 0) {
    // Delete from role_task_assignments
    await conn.query("DELETE FROM campusone.role_task_assignments WHERE role_id = ? AND task_id IN (?)", [deanRoleId, fTaskIds]);
    
    // Delete from role_tasks (subtasks belonging to forbidden tasks)
    await conn.query(`
      DELETE rt FROM campusone.role_tasks rt
      JOIN campusone.sub_tasks st ON st.id = rt.sub_task_id
      WHERE rt.role_id = ? AND st.task_id IN (?)
    `, [deanRoleId, fTaskIds]);
    console.log(`✅ Removed forbidden tasks and subtasks for DEAN: ${fTasks.map((t: any) => t.code).join(', ')}`);
  }

  // 2. Ensure DEAN has all allowed Academic & Student Affairs tasks:
  // home, academics, principal, attendance, members, admissions, leave, approvals, grievances, comms, reports
  const allowedTaskCodes = [
    'home',
    'academics',
    'principal',
    'attendance',
    'members',
    'admissions',
    'leave',
    'approvals',
    'grievances',
    'comms',
    'reports'
  ];

  const [aTasks]: any = await conn.query("SELECT id, code FROM campusone.tasks WHERE code IN (?)", [allowedTaskCodes]);
  const aTaskIds = aTasks.map((t: any) => t.id);

  for (const tid of aTaskIds) {
    await conn.query("INSERT IGNORE INTO campusone.role_task_assignments (role_id, task_id) VALUES (?, ?)", [deanRoleId, tid]);
  }

  // Assign corresponding subtasks to role_tasks
  const [subtasks]: any = await conn.query("SELECT id FROM campusone.sub_tasks WHERE task_id IN (?)", [aTaskIds]);
  for (const st of subtasks) {
    await conn.query("INSERT IGNORE INTO campusone.role_tasks (role_id, sub_task_id) VALUES (?, ?)", [deanRoleId, st.id]);
  }
  console.log(`✅ Configured ${aTasks.length} core tasks and ${subtasks.length} subtasks strictly for DEAN!`);

  // 3. Clean up Profile 1109 (Pravin Patil): ensure only Role 30 (DEAN) and appropriate roles
  // Remove any conflicting role like Merchant or Crew
  await conn.query("DELETE FROM campusone_cug.profile_roles WHERE profile_id = 1109 AND role_id NOT IN (30, 28, 8)");
  console.log("✅ Profile 1109 profile_roles scoped strictly to DEAN / Academic Leadership");

  await conn.end();
}

updateDeanRoles().catch(console.error);
