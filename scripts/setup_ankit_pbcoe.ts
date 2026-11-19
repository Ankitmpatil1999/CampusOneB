import mysql from 'mysql2/promise';
import { hashSecret, verifySecret } from '../utils/password';
import { v7 as uuidv7, parse as uuidParse } from 'uuid';

const newPublicId = () => Buffer.from(uuidParse(uuidv7()));

async function setupAnkitPBCOE() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const email = 'ankitpatil.sabado@gmail.com';
  const rawPassword = 'Ankit@1999';
  const mobile = '9822001999';
  const firstName = 'Ankit';
  const lastName = 'Patil';
  const instId = 6; // PBCOE

  console.log(`Setting up ${email} for PBCOE (ID: ${instId})...`);

  // Check if account already exists
  const [existingAcc]: any = await conn.query('SELECT * FROM campusone.platform_accounts WHERE email = ?', [email]);
  let accountId: number;

  const passwordHash = await hashSecret(rawPassword);

  if (existingAcc.length > 0) {
    accountId = existingAcc[0].id;
    console.log(`Found existing account ID ${accountId}`);
    await conn.query('UPDATE campusone.platform_accounts SET status = "ACTIVE", failed_signins = 0, locked_until = NULL WHERE id = ?', [accountId]);
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

    // Insert credential
    await conn.query(`
      INSERT INTO campusone.account_credentials (
        account_id, kind, hash, set_at, failed_attempts, row_version
      ) VALUES (?, 'PASSWORD', ?, NOW(3), 0, 1)
    `, [accountId, passwordHash]);
    console.log(`Created credential with Argon2 hash`);
  }

  // Check user_types for PBCOE
  const [uts]: any = await conn.query('SELECT id FROM campusone_cug.user_types WHERE institution_id = ? AND category = "STAFF" LIMIT 1', [instId]);
  const userTypeId = uts[0]?.id || 17;

  // Check departments
  const [deps]: any = await conn.query('SELECT id FROM campusone_cug.departments WHERE institution_id = ? LIMIT 1', [instId]);
  const depId = deps[0]?.id || 19;

  // Check if member profile already exists for this account in PBCOE
  const [existingProf]: any = await conn.query('SELECT * FROM campusone_cug.member_profiles WHERE institution_id = ? AND account_id = ?', [instId, accountId]);
  let profileId: number;

  if (existingProf.length > 0) {
    profileId = existingProf[0].id;
    console.log(`Found existing profile ID ${profileId}`);
    await conn.query('UPDATE campusone_cug.member_profiles SET status = "ACTIVE" WHERE id = ?', [profileId]);
  } else {
    const profPubId = newPublicId();
    const [resProf]: any = await conn.query(`
      INSERT INTO campusone_cug.member_profiles (
        public_id, institution_id, account_id, own_account_id, user_type_id, department_id,
        first_name, last_name, contact_mobile, contact_email, employee_no, admission_no,
        joined_on, status, txn_permission, row_version, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, 'EMP-PBCOE-ADMIN', 'EMP-PBCOE-ADMIN',
        CURDATE(), 'ACTIVE', 1, 1, NOW(3), NOW(3)
      )
    `, [profPubId, instId, accountId, accountId, userTypeId, depId, firstName, lastName, mobile, email]);
    profileId = resProf.insertId;
    console.log(`Created member_profile ID ${profileId}`);
  }

  // Assign roles: INSTITUTION_ADMIN (1) and PRINCIPAL_ASSISTANT (28)
  const roleIds = [1, 28];
  for (const rId of roleIds) {
    const [hasRole]: any = await conn.query('SELECT * FROM campusone_cug.profile_roles WHERE profile_id = ? AND role_id = ?', [profileId, rId]);
    if (hasRole.length === 0) {
      await conn.query('INSERT INTO campusone_cug.profile_roles (institution_id, profile_id, role_id, created_at) VALUES (?, ?, ?, NOW(3))', [instId, profileId, rId]);
      console.log(`Assigned role ID ${rId} to profile ${profileId}`);
    }
  }

  console.log('\nVerifying login with verifySecret...');
  const [cred]: any = await conn.query('SELECT hash FROM campusone.account_credentials WHERE account_id = ?', [accountId]);
  const isMatch = await verifySecret(cred[0].hash, rawPassword);
  console.log(`Password verify check: ${isMatch ? 'PASSED ✅' : 'FAILED ❌'}`);

  await conn.end();
}

setupAnkitPBCOE().catch(console.error);
