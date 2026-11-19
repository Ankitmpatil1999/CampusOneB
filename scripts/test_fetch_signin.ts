async function run() {
  const emails = [
    'dean@pbcoe.edu.in',
    'rohit.26me001@pbcoe.edu.in',
    'coordinator@pbcoe.edu.in',
    'principal@pbcoe.edu.in',
    'hod.cse@pbcoe.edu.in'
  ];
  for (const email of emails) {
    try {
      const res = await fetch('http://localhost:3000/api/v1/auth/staff/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'Hello@123' })
      });
      const data = await res.json();
      console.log(`${email} -> HTTP ${res.status}:`, JSON.stringify(data));
    } catch (e: any) {
      console.error(`${email} -> Fetch error:`, e.message);
    }
  }
}
run();
