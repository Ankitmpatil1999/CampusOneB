import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  // Check member_profile for Kalpana
  const [kalpana]: any = await conn.query(`
    SELECT mp.id, mp.first_name, mp.last_name, ut.name as user_type, ut.category
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE mp.id = 1112
  `);
  console.log('Kalpana profile:', kalpana[0]);

  // Check roles assigned to account
  const [roles]: any = await conn.query(`
    SELECT r.id, r.name, r.code
    FROM campusone.roles r
    JOIN campusone.role_task_assignments rta ON rta.role_id = r.id
    WHERE r.code LIKE '%teach%' OR r.name LIKE '%teach%' OR r.name LIKE '%Faculty%'
    LIMIT 10
  `);
  console.log('Teaching roles:', roles);

  // Check all tasks with teaching
  const [tasks]: any = await conn.query(`
    SELECT * FROM campusone.role_tasks WHERE code LIKE '%teach%'
  `);
  console.log('Teaching role_tasks:', tasks);

  // Check sub_tasks with teaching
  const [subTasks]: any = await conn.query(`
    SELECT * FROM campusone.sub_tasks WHERE code LIKE '%teach%'
  `);
  console.log('Teaching sub_tasks:', subTasks);

  await conn.end();
}

main().catch(console.error);
