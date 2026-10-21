/**
 * A staff member onboarded as the console's Staff tab does (IDN-053). Single onboarding is for
 * students only (client 2026-10-19), so teachers, principals and every other role the suites need
 * come this way: the user type's first department, linked to the RingPe account of the mobile when
 * there is one (else an account is made, with a temporary password).
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';

export async function onboardStaff(
  app: Parameters<typeof request>[0],
  con: Record<string, string>,
  v: {
    userTypeId: string;
    firstName: string;
    mobile: string;
    lastName?: string;
    customFields?: Record<string, unknown>;
  },
) {
  const types = (await request(app).get('/api/v1/console/user-types').set(con)).body.items as {
    id: string;
    departments: { id: string }[];
  }[];
  const departmentId = types.find((t) => t.id === v.userTypeId)?.departments[0]?.id;
  return request(app)
    .post('/api/v1/console/staff')
    .set(con)
    .set('Idempotency-Key', randomUUID())
    .send({
      userTypeId: v.userTypeId,
      departmentId,
      firstName: v.firstName,
      ...(v.lastName ? { lastName: v.lastName } : {}),
      gender: 'FEMALE',
      dateOfBirth: '1990-01-15',
      mobile: v.mobile,
      email: `${v.firstName.toLowerCase().replace(/[^a-z]/g, '')}.${randomInt(0, 1e9)}@example.in`,
      joinedOn: '2026-06-01',
      ...(v.customFields ? { customFields: v.customFields } : {}),
    });
}
