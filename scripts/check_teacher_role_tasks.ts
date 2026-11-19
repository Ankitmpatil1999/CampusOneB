import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [teachingSubTasks]: any = await conn.query("SELECT * FROM campusone.sub_tasks WHERE code LIKE '%teach%'");
  console.log('Teaching sub_tasks:');
  console.table(teachingSubTasks);

  const [roleTasks]: any = await conn.query(`
    SELECT rt.role_id, r.name as role_name, st.id as sub_task_id, st.code as sub_task_code
    FROM campusone.role_tasks rt
    JOIN campusone.roles r ON r.id = rt.role_id
    JOIN campusone.sub_tasks st ON st.id = rt.sub_task_id
    WHERE st.code LIKE '%teach%' OR r.id = 2
  `);
  console.log('Role tasks:');
  console.table(roleTasks);

  // How does a user get roles? Check member_profiles or platform_accounts
  const [kalpanaAcc]: any = await conn.query(`
    SELECT pa.id, pa.email, pa.roles, mp.user_type_id, ut.name as user_type_name
    FROM campusone_cug.member_profiles mp
    JOIN campusone.platform_accounts pa ON pa.id = mp.account_id
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE mp.id = 1112
  `);
  console.log('Kalpana platform account:', kalpanaAcc);

  await conn.end();
}

main().catch(console.error);
