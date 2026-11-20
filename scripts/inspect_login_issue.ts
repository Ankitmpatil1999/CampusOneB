import mysql from 'mysql2/promise';

async function check() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [rows]: any = await conn.query(`
    SELECT mp.id, mp.first_name, mp.last_name, mp.user_type_id, ut.name as user_type_name, ut.category,
           pa.email, pa.id as account_id
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    LEFT JOIN campusone.platform_accounts pa ON pa.id = mp.account_id
    WHERE mp.institution_id = 6 AND (mp.first_name LIKE '%Pravin%' OR pa.email LIKE '%coordinator%' OR pa.email LIKE '%dean%')
  `);
  console.log('Profiles:', rows);

  const [roles]: any = await conn.query(`
    SELECT pr.profile_id, r.id as role_id, r.name as role_name, r.code
    FROM campusone_cug.profile_roles pr
    JOIN campusone.roles r ON r.id = pr.role_id
    WHERE pr.profile_id IN (${rows.map((r: any) => r.id).join(',') || '0'})
  `);
  console.log('Roles:', roles);

  // Check subtasks in role_task_assignments
  const [tasks]: any = await conn.query(`
    SELECT DISTINCT pr.profile_id, t.code
    FROM campusone_cug.profile_roles pr
    JOIN campusone.role_task_assignments rta ON rta.role_id = pr.role_id
    JOIN campusone.role_tasks t ON t.id = rta.task_id
    WHERE pr.profile_id IN (${rows.map((r: any) => r.id).join(',') || '0'})
    AND t.code LIKE 'teaching%'
  `);
  console.log('Teaching tasks:', tasks);

  // Check teacher_assignments for these profiles
  const [teachAss]: any = await conn.query(`
    SELECT ta.id, ta.teacher_profile_id, ta.kind, ta.section_id, ta.subject_id
    FROM campusone_cug.teacher_assignments ta
    WHERE ta.teacher_profile_id IN (${rows.map((r: any) => r.id).join(',') || '0'})
    AND ta.ended_at IS NULL
  `);
  console.log('Teacher assignments:', teachAss);

  await conn.end();
}

check().catch(console.error);
