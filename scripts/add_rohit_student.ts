import mysql from 'mysql2/promise';
import { hashSecret } from '../utils/password';
import { v7 as uuidv7, parse as uuidParse } from 'uuid';

const newPublicId = () => Buffer.from(uuidParse(uuidv7()));

async function addRohit() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const email = 'rohit.26me001@pbcoe.edu.in';
  const mobile = '9823100268';
  const rawPassword = 'Hello@123';
  const instId = 6;
  const deptId = 26; // Mechanical

  // Check if exists
  const [exist]: any = await conn.query('SELECT id FROM campusone.platform_accounts WHERE email = ?', [email]);
  if (exist.length > 0) {
    console.log('Already exists, account ID:', exist[0].id);
    await conn.end();
    return;
  }

  const passwordHash = await hashSecret(rawPassword);

  const accPubId = newPublicId();
  const [resAcc]: any = await conn.query(`
    INSERT INTO campusone.platform_accounts (
      public_id, mobile, email, email_verified_at, first_name, last_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, NOW(3), 'Rohit', 'Sharma', 'ACTIVE', NOW(3), NOW(3))
  `, [accPubId, mobile, email]);
  const accountId = resAcc.insertId;

  await conn.query(`
    INSERT INTO campusone.account_credentials (
      account_id, kind, hash, set_at, failed_attempts, row_version
    ) VALUES (?, 'PASSWORD', ?, NOW(3), 0, 1)
  `, [accountId, passwordHash]);

  // Insert profile as STUDENT
  const profPubId = newPublicId();
  await conn.query(`
    INSERT INTO campusone_cug.member_profiles (
      public_id, institution_id, account_id, own_account_id, user_type_id, department_id,
      first_name, last_name, contact_mobile, contact_email, employee_no, admission_no,
      joined_on, status, txn_permission, row_version, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, 21, ?,
      'Rohit', 'Sharma', ?, ?, '26ME001', '26ME001',
      CURDATE(), 'ACTIVE', 1, 1, NOW(3), NOW(3)
    )
  `, [profPubId, instId, accountId, accountId, deptId, mobile, email]);

  console.log('✅ Added Rohit Sharma (26ME001) as student in PBCOE Mechanical department!');
  await conn.end();
}

addRohit().catch(console.error);
