import mysql from 'mysql2/promise';
import { verifySecret } from '../utils/password';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');

  console.log('--- 1. Account for dean@pbcoe.edu.in ---');
  const [accs]: any = await conn.query(`
    SELECT pa.id, pa.email, pa.mobile, pa.status, pa.failed_signins, pa.locked_until, ac.hash, ac.kind
    FROM campusone.platform_accounts pa
    LEFT JOIN campusone.account_credentials ac ON ac.account_id = pa.id
    WHERE pa.email = 'dean@pbcoe.edu.in'
  `);
  console.table(accs);

  if (accs.length > 0) {
    const acc = accs[0];
    console.log('Password check for Hello@123:', await verifySecret(acc.hash, 'Hello@123'));

    console.log('\n--- 2. Member Profiles for account ---');
    const [profs]: any = await conn.query(`
      SELECT mp.id, mp.institution_id, mp.first_name, mp.last_name, mp.status, ut.category, ut.name as user_type_name
      FROM campusone_cug.member_profiles mp
      JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
      WHERE mp.account_id = ?
    `, [acc.id]);
    console.table(profs);

    if (profs.length > 0) {
      const profId = profs[0].id;
      console.log('\n--- 3. Profile Roles for profile ---');
      const [roles]: any = await conn.query(`
        SELECT pr.*, r.code, r.name, r.status as role_status
        FROM campusone_cug.profile_roles pr
        JOIN campusone.roles r ON r.id = pr.role_id
        WHERE pr.profile_id = ?
      `, [profId]);
      console.table(roles);

      if (roles.length > 0) {
        const roleId = roles[0].role_id;
        console.log(`\n--- 4. Role Task Assignments for role_id = ${roleId} (${roles[0].code}) ---`);
        const [rtas]: any = await conn.query(`
          SELECT rta.*, rt.code as task_code, rt.name as task_name
          FROM campusone.role_task_assignments rta
          JOIN campusone.role_tasks rt ON rt.id = rta.task_id
          WHERE rta.role_id = ?
        `, [roleId]);
        console.table(rtas);
      }
    }
  }

  console.log('\n--- 5. All Roles and their task assignment counts ---');
  const [roleCounts]: any = await conn.query(`
    SELECT r.id, r.code, r.name, COUNT(rta.task_id) as assigned_tasks
    FROM campusone.roles r
    LEFT JOIN campusone.role_task_assignments rta ON rta.role_id = r.id
    GROUP BY r.id
    ORDER BY r.id ASC
  `);
  console.table(roleCounts);

  await conn.end();
}

main().catch(console.error);
