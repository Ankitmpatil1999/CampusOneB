import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [roleTasksCols]: any = await conn.query('DESCRIBE campusone.role_tasks');
  console.log('role_tasks cols:', roleTasksCols.map((c: any) => c.Field));

  const [subTasksCols]: any = await conn.query('DESCRIBE campusone.sub_tasks');
  console.log('sub_tasks cols:', subTasksCols.map((c: any) => c.Field));

  // Check what subtasks role 2 (Teacher) has
  const [roleSubtasks]: any = await conn.query(`
    SELECT rta.*, st.*
    FROM campusone.role_task_assignments rta
    JOIN campusone.sub_tasks st ON st.id = rta.sub_task_id
    WHERE rta.role_id = 2
  `);
  console.log('Teacher role (2) subtasks:');
  console.table(roleSubtasks);

  // Check user_types in campusone_cug for TEACHER
  const [userTypes]: any = await conn.query('SELECT * FROM campusone_cug.user_types WHERE category = "TEACHER"');
  console.log('user_types for TEACHER:', userTypes);

  await conn.end();
}

main().catch(console.error);
