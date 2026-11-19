import mysql from 'mysql2/promise';
import { verifySecret } from '../utils/password.js';

async function test() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [accs]: any = await conn.query(`
    SELECT a.id, a.email, a.status, a.failed_signins, a.locked_until, a.signin_lock,
           c.kind, c.hash, c.failed_attempts, c.locked_until as cred_locked
    FROM campusone.platform_accounts a
    LEFT JOIN campusone.account_credentials c ON c.account_id = a.id
    WHERE a.email IN ('dean@pbcoe.edu.in', 'rohit.26me001@pbcoe.edu.in', 'coordinator@pbcoe.edu.in', 'hod.cse@pbcoe.edu.in', 'principal@pbcoe.edu.in')
  `);
  console.log('--- ACCOUNTS & CREDENTIALS ---');
  for (const acc of accs) {
    let match = false;
    if (acc.hash) {
      match = await verifySecret(acc.hash, 'Hello@123');
    }
    console.log(`- ${acc.email} (id: ${acc.id}, status: ${acc.status}, failed: ${acc.failed_signins}, lock: ${acc.signin_lock}, cred_lock: ${acc.cred_locked}) -> Password match Hello@123: ${match}`);
  }

  // Also check consoleProfiles for dean
  const dean = accs.find((a: any) => a.email === 'dean@pbcoe.edu.in');
  if (dean) {
    console.log('\n--- DEAN CHECK ---');
    const [profiles]: any = await conn.query(`
      SELECT p.id as profile_id, p.first_name, p.last_name, p.status, ut.category, i.name as institution_name
      FROM campusone_cug.member_profiles p
      JOIN campusone_cug.institutions i ON i.id = p.institution_id
      JOIN campusone_cug.user_types ut ON ut.id = p.user_type_id
      WHERE p.account_id = ?
    `, [dean.id]);
    console.log('Dean profiles:', profiles);

    if (profiles.length > 0) {
      const [roles]: any = await conn.query(`
        SELECT pr.profile_id, r.id as role_id, r.name as role_name, r.status as role_status, COUNT(rta.id) as task_count
        FROM campusone_cug.profile_roles pr
        JOIN campusone_cug.roles r ON r.id = pr.role_id
        LEFT JOIN campusone_cug.role_task_assignments rta ON rta.role_id = r.id
        WHERE pr.profile_id IN (?)
        GROUP BY pr.profile_id, r.id, r.name, r.status
      `, [profiles.map((p: any) => p.profile_id)]);
      console.log('Dean roles & tasks:', roles);
    }
  }

  // Also check Rohit (student)
  const rohit = accs.find((a: any) => a.email === 'rohit.26me001@pbcoe.edu.in');
  if (rohit) {
    console.log('\n--- ROHIT (STUDENT) CHECK ---');
    const [profiles]: any = await conn.query(`
      SELECT p.id as profile_id, p.first_name, p.last_name, p.status, ut.category, i.name as institution_name
      FROM campusone_cug.member_profiles p
      JOIN campusone_cug.institutions i ON i.id = p.institution_id
      JOIN campusone_cug.user_types ut ON ut.id = p.user_type_id
      WHERE p.account_id = ?
    `, [rohit.id]);
    console.log('Rohit profiles:', profiles);
  }

  // Also check Pravin Patil (coordinator) roles and tasks
  const coord = accs.find((a: any) => a.email === 'coordinator@pbcoe.edu.in');
  if (coord) {
    console.log('\n--- COORDINATOR CHECK ---');
    const [profiles]: any = await conn.query(`
      SELECT p.id as profile_id, p.first_name, p.last_name, p.status, ut.category, i.name as institution_name
      FROM campusone_cug.member_profiles p
      JOIN campusone_cug.institutions i ON i.id = p.institution_id
      JOIN campusone_cug.user_types ut ON ut.id = p.user_type_id
      WHERE p.account_id = ?
    `, [coord.id]);
    console.log('Coordinator profiles:', profiles);

    if (profiles.length > 0) {
      const [roles]: any = await conn.query(`
        SELECT pr.profile_id, r.id as role_id, r.name as role_name, r.status as role_status, COUNT(rta.id) as task_count
        FROM campusone_cug.profile_roles pr
        JOIN campusone_cug.roles r ON r.id = pr.role_id
        LEFT JOIN campusone_cug.role_task_assignments rta ON rta.role_id = r.id
        WHERE pr.profile_id IN (?)
        GROUP BY pr.profile_id, r.id, r.name, r.status
      `, [profiles.map((p: any) => p.profile_id)]);
      console.log('Coordinator roles & tasks:', roles);

      const [assignedTasks]: any = await conn.query(`
        SELECT DISTINCT r.name as role_name, t.code, t.name as task_name
        FROM campusone_cug.profile_roles pr
        JOIN campusone_cug.roles r ON r.id = pr.role_id
        JOIN campusone_cug.role_task_assignments rta ON rta.role_id = r.id
        JOIN campusone.role_tasks t ON t.id = rta.task_id
        WHERE pr.profile_id IN (?)
      `, [profiles.map((p: any) => p.profile_id)]);
      console.log('Coordinator specific tasks count:', assignedTasks.length);
      console.log('Coordinator teaching tasks:', assignedTasks.filter((t: any) => t.code.startsWith('teaching')));
    }
  }

  await conn.end();
}
test().catch(console.error);
