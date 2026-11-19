import mysql from 'mysql2/promise';
import { verifySecret } from '../utils/password';

async function test() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  console.log('--- Search MECH students in PBCOE ---');
  const [rows]: any = await conn.query(`
    SELECT mp.id, mp.first_name, mp.last_name, mp.admission_no, mp.account_id, pa.email, pa.mobile 
    FROM campusone_cug.member_profiles mp 
    LEFT JOIN campusone.platform_accounts pa ON pa.id = mp.account_id 
    WHERE mp.institution_id = 6 AND (mp.department_id = 26 OR mp.first_name LIKE '%Rohit%' OR mp.admission_no LIKE '%ME%')
  `);
  console.table(rows);
  await conn.end();
}
test().catch(console.error);
