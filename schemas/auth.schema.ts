import { z } from 'zod';

export const refreshRequestSchema = z
  .strictObject({
    refreshToken: z
      .string()
      .min(20)
      .max(200)
      .optional()
      .describe('Member app only. Web sessions send the refresh cookie instead.'),
  })
  .meta({ id: 'RefreshRequest' });

export const sessionTokensSchema = z
  .object({
    sessionId: z.uuid(),
    accessTokenExpiresAt: z.iso.datetime(),
    refreshTokenExpiresAt: z.iso.datetime(),
    accessToken: z.string().optional().describe('Returned to the member app only'),
    refreshToken: z.string().optional().describe('Returned to the member app only'),
  })
  .meta({ id: 'SessionTokens' });

export const jwksSchema = z
  .object({
    keys: z.array(
      z.object({
        kty: z.literal('EC'),
        crv: z.literal('P-256'),
        x: z.string(),
        y: z.string(),
        kid: z.string(),
        alg: z.literal('ES256'),
        use: z.literal('sig'),
      }),
    ),
  })
  .meta({ id: 'Jwks' });
