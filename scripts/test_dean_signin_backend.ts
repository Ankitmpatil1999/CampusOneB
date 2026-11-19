import { createKysely } from '../src/db.js';
import { accessRepository } from '../repositories/access.repository.js';

async function test() {
  const db = createKysely();
  try {
    const account = await accessRepository.findAccountByEmail(db, 'dean@pbcoe.edu.in');
    console.log('Account:', account);
    if (account) {
      const contexts = await accessRepository.consoleContexts(db, account.id);
      console.log('Console contexts for dean:', contexts);

      const op = await accessRepository.operatorContext(db, account.id);
      console.log('Operator context for dean:', op);

      const hasInst = await accessRepository.hasInstitutionProfile(db, account.id);
      console.log('Has institution profile:', hasInst);
    }
  } catch (err) {
    console.error('Error running test:', err);
  } finally {
    await db.destroy();
  }
}

test();
