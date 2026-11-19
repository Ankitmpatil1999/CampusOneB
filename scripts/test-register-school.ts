import { loadConfigOrExit, createRuntime } from '../config/bootstrap';
import { createSecurity } from '../config/security';
import { buildApiServices } from '../config/services';
import { createRateLimiter } from '../middlewares/rate-limit.middleware';

async function test() {
  console.log('Loading config & runtime...');
  const config = loadConfigOrExit();
  const runtime = createRuntime(config, 'api');
  const security = await createSecurity(config, runtime.loggers, runtime.redis);
  const services = buildApiServices({
    db: runtime.database.db,
    config,
    security,
    loggers: runtime.loggers,
    authLimiter: createRateLimiter({
      name: 'auth',
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.authMax,
      exemptIps: config.rateLimit.exemptIps,
    }),
  });

  const payload = {
    name: 'Sun Rice Convent',
    address: 'Rameshwari Ring Road nagpur',
    city: 'Nagpue',
    board: 'State',
    primaryContact: {
      name: 'Geeta Patil',
      email: 'geeta@gmail.com',
      mobile: '8180093401',
    },
    adminEmail: 'geeta@gmail.com',
  };

  console.log('\nCalling institutions.register with payload:', JSON.stringify(payload, null, 2));
  try {
    const actor = {
      type: 'OPERATOR' as const,
      sub: '9',
      roles: ['SUPER_ADMIN', 'PLATFORM_OPERATOR'],
    };
    const res = await services.institutions.register(actor as any, payload as any);
    console.log('\n>>> REGISTRATION SUCCESS! <<<', res);
  } catch (err: any) {
    console.error('\n*** REGISTRATION FAILED ***');
    console.error('Error name:', err.name);
    console.error('Error message:', err.message);
    console.error('Error status:', err.status || err.statusCode);
    console.error('Error details:', err.details || err.errors || err);
    if (err.stack) console.error('Stack:', err.stack);
  } finally {
    await runtime.database.db.destroy();
    if (runtime.redis) await runtime.redis.quit();
  }
}

test();
