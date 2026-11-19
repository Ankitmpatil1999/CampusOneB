import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [rows]: any = await conn.query(`
    SELECT cs.class_id, c.name as class_name, COUNT(cs.subject_id) as subject_count
    FROM campusone_cug.classes c
    LEFT JOIN campusone_cug.class_subjects cs ON cs.class_id = c.id
    WHERE c.institution_id = 6
    GROUP BY c.id, c.name
    ORDER BY c.id
  `);
  console.table(rows);
  await conn.end();
}

main().catch(console.error);
