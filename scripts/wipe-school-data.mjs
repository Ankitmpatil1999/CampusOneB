import mysql from 'mysql2/promise';
import fs from 'node:fs';

const DB_URL = process.env.DB_MIGRATOR_URL || 'mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone';

async function wipe() {
  console.log('Connecting to MySQL...');
  const conn = await mysql.createConnection(DB_URL);

  try {
    // 1. Verify backup file exists
    const backupPath = 'D:\\Personal Project\\CampusOne\\CampusOne_Backend_API\\db_backups_before_wipe.sql';
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Safety check failed: Backup file not found at ${backupPath}`);
    }
    const stats = fs.statSync(backupPath);
    console.log(`Safety verification: Backup file exists (${(stats.size / 1024 / 1024).toFixed(2)} MB).`);

    console.log('\n--- Disabling Foreign Key Checks ---');
    await conn.query('SET FOREIGN_KEY_CHECKS = 0;');

    // 2. Fetch all tables from campusone_cug
    const [cugTablesResult] = await conn.query('SHOW TABLES FROM campusone_cug');
    const cugTables = cugTablesResult.map(t => Object.values(t)[0]);
    console.log(`Found ${cugTables.length} tables in campusone_cug.`);

    console.log('\n--- Truncating all school/college tables in campusone_cug ---');
    for (const table of cugTables) {
      await conn.query(`TRUNCATE TABLE campusone_cug.\`${table}\``);
    }
    console.log(`Successfully truncated all ${cugTables.length} tables in campusone_cug!`);

    // 3. Clean school data from platform DB (campusone)
    console.log('\n--- Cleaning school records from platform DB (campusone) ---');
    
    // Subscriptions of schools
    const [delSubs] = await conn.query('DELETE FROM campusone.subscriptions');
    console.log(`Deleted ${delSubs.affectedRows} school subscriptions.`);

    // Invoices of schools (append-only triggers require TRUNCATE)
    await conn.query('TRUNCATE TABLE campusone.invoice_payments');
    await conn.query('TRUNCATE TABLE campusone.invoice_lines');
    await conn.query('TRUNCATE TABLE campusone.invoices');
    console.log('Truncated school invoices tables.');

    // Non-operator platform accounts (school management, teachers, students, parents)
    const [opAccs] = await conn.query('SELECT account_id FROM campusone.operator_accounts');
    const operatorAccountIds = opAccs.map(r => r.account_id);
    console.log(`Preserving ${operatorAccountIds.length} Platform Operator accounts (Super Admins).`);

    const [delCreds] = await conn.query(
      `DELETE FROM campusone.account_credentials WHERE account_id NOT IN (${operatorAccountIds.join(',')})`
    );
    console.log(`Deleted ${delCreds.affectedRows} school account credentials.`);

    const [delAccs] = await conn.query(
      `DELETE FROM campusone.platform_accounts WHERE id NOT IN (${operatorAccountIds.join(',')})`
    );
    console.log(`Deleted ${delAccs.affectedRows} school platform accounts.`);

    // Clear all sessions, refresh tokens & OTP challenges
    await conn.query('TRUNCATE TABLE campusone.sessions');
    await conn.query('TRUNCATE TABLE campusone.refresh_tokens');
    await conn.query('TRUNCATE TABLE campusone.otp_challenges');

    console.log('\n--- Re-seeding required persistent sequence tables ---');
    await conn.query(`
      INSERT INTO campusone_cug.wallet_number_sequences (kind, next_value) VALUES 
      ('CAMPUS', 555500001),
      ('ALLOWANCE', 565656000000001),
      ('PERSONAL', 888888800000001)
      ON DUPLICATE KEY UPDATE next_value = VALUES(next_value);
    `);
    console.log('wallet_number_sequences re-seeded.');

    console.log('\n--- Re-enabling Foreign Key Checks ---');
    await conn.query('SET FOREIGN_KEY_CHECKS = 1;');

    console.log('\n============================================================');
    console.log('SUCCESS: All School and College data has been cleanly removed!');
    console.log('Super Admin account (arjun@campusone.example) is PRESERVED.');
    console.log('You can now log in to /backoffice and onboard fresh institutions.');
    console.log('============================================================\n');

  } catch (err) {
    console.error('Error during wipe:', err);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1;').catch(() => {});
    process.exit(1);
  } finally {
    await conn.end();
  }
}

wipe();
