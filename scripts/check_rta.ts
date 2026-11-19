import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [cols]: any = await conn.query('DESCRIBE campusone.role_task_assignments');
  console.log('role_task_assignments cols:', cols.map((c: any) => c.Field));

  const [sample]: any = await conn.query('SELECT * FROM campusone.role_task_assignments LIMIT 5');
  console.log('sample role_task_assignments:', sample);
  await conn.end();
}

main().catch(console.error);
