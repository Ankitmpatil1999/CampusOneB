import { hashSecret } from '../utils/password';
import mysql from 'mysql2/promise';

async function updateCreds() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  // Account ID 9 is the primary Super Admin (Platform Administrator)
  const accountId = 9;
  const newEmail = 'aryapatil963@gmail.com';
  const newPassword = 'Ankit@1999';

  const passwordHash = await hashSecret(newPassword);
  console.log('Generated Argon2 hash for new password.');

  // Update email in platform_accounts
  await conn.query('UPDATE campusone.platform_accounts SET email = ? WHERE id = ?', [newEmail, accountId]);
  console.log(`Updated platform_accounts ID ${accountId} email to: ${newEmail}`);

  // Update password in account_credentials
  const [result] = await conn.query(
    'UPDATE campusone.account_credentials SET hash = ?, failed_attempts = 0, locked_until = NULL, set_at = NOW(3) WHERE account_id = ? AND kind = "PASSWORD"',
    [passwordHash, accountId]
  );
  console.log('Updated password hash in account_credentials:', result);

  // Verify
  const [verifyAcc] = await conn.query('SELECT id, email, first_name, last_name FROM campusone.platform_accounts WHERE id = ?', [accountId]);
  console.log('\nVerified platform_account:', (verifyAcc as any)[0]);

  const [verifyCred] = await conn.query('SELECT account_id, kind, set_at FROM campusone.account_credentials WHERE account_id = ?', [accountId]);
  console.log('Verified account_credentials:', (verifyCred as any)[0]);

  await conn.end();
  console.log('\n============================================================');
  console.log(`SUCCESS: Super Admin login updated:`);
  console.log(`Email:    ${newEmail}`);
  console.log(`Password: ${newPassword}`);
  console.log('============================================================\n');
}

updateCreds().catch(console.error);
