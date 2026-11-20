import mysql from 'mysql2/promise';
import { hashSecret, verifySecret } from '../utils/password';
import { v7 as uuidv7, parse as uuidParse } from 'uuid';

const newPublicId = () => Buffer.from(uuidParse(uuidv7()));

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');

  const email = 'ankitpatil@gmail.com';
  const rawPassword = 'Ankit@1999';
  const mobile = '9822001998';
  const firstName = 'Ankit';
  const lastName = 'Patil';

  console.log(`Setting up Super Management / Operator account for ${email}...`);

  // Check if account already exists
  const [existingAcc]: any = await conn.query('SELECT * FROM campusone.platform_accounts WHERE email = ?', [email]);
  let accountId: number;

  const passwordHash = await hashSecret(rawPassword);

  if (existingAcc.length > 0) {
    accountId = existingAcc[0].id;
    console.log(`Found existing account ID ${accountId}`);
    await conn.query('UPDATE campusone.platform_accounts SET mobile = ?, status = "ACTIVE", signin_lock = "UNLOCKED", failed_signins = 0, locked_until = NULL WHERE id = ?', [mobile, accountId]);
    const [existCred]: any = await conn.query('SELECT id FROM campusone.account_credentials WHERE account_id = ? AND kind = "PASSWORD"', [accountId]);
    if (existCred.length > 0) {
      await conn.query('UPDATE campusone.account_credentials SET hash = ?, failed_attempts = 0, locked_until = NULL WHERE account_id = ? AND kind = "PASSWORD"', [passwordHash, accountId]);
    } else {
      await conn.query('INSERT INTO campusone.account_credentials (account_id, kind, hash, set_at, failed_attempts, row_version) VALUES (?, "PASSWORD", ?, NOW(3), 0, 1)', [accountId, passwordHash]);
    }
  } else {
    const accPubId = newPublicId();
    const [res]: any = await conn.query(`
      INSERT INTO campusone.platform_accounts (
        public_id, mobile, email, email_verified_at, first_name, last_name, status, created_at, updated_at
      ) VALUES (?, ?, ?, NOW(3), ?, ?, 'ACTIVE', NOW(3), NOW(3))
    `, [accPubId, mobile, email, firstName, lastName]);
    accountId = res.insertId;
    console.log(`Created new platform_account ID ${accountId}`);

    await conn.query(`
      INSERT INTO campusone.account_credentials (
        account_id, kind, hash, set_at, failed_attempts, row_version
      ) VALUES (?, 'PASSWORD', ?, NOW(3), 0, 1)
    `, [accountId, passwordHash]);
    console.log(`Created credential with Argon2 hash`);
  }

  // Ensure this account is in operator_accounts with PLATFORM_ADMIN role (ID 13)
  const [existingOp]: any = await conn.query('SELECT * FROM campusone.operator_accounts WHERE account_id = ?', [accountId]);
  if (existingOp.length > 0) {
    await conn.query('UPDATE campusone.operator_accounts SET role_id = 13, status = "ACTIVE" WHERE id = ?', [existingOp[0].id]);
    console.log(`Updated operator_accounts ID ${existingOp[0].id} to role PLATFORM_ADMIN (13)`);
  } else {
    const opPubId = newPublicId();
    await conn.query(`
      INSERT INTO campusone.operator_accounts (
        public_id, account_id, role_id, status, row_version, created_at, updated_at
      ) VALUES (?, ?, 13, 'ACTIVE', 1, NOW(3), NOW(3))
    `, [opPubId, accountId]);
    console.log(`Created new operator_account with PLATFORM_ADMIN (13)`);
  }

  // Verify that there are NO active member_profiles for this account so that RNG-IDN-043 doesn't block ops access
  const [mems]: any = await conn.query('SELECT id, status FROM campusone_cug.member_profiles WHERE account_id = ?', [accountId]);
  console.log(`Member profiles for ${email}:`, mems);

  // Test password verification
  const [cred]: any = await conn.query('SELECT hash FROM campusone.account_credentials WHERE account_id = ?', [accountId]);
  const isMatch = await verifySecret(cred[0].hash, rawPassword);
  console.log(`Password verification check: ${isMatch ? 'PASSED ✅' : 'FAILED ❌'}`);

  await conn.end();
}

main().catch(console.error);
