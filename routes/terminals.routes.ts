import { Router, type Request, type RequestHandler } from 'express';
import type { Kysely } from 'kysely';
import { defineRoute } from '../config/openapi-registry';
import type { Loggers } from '../controllers/logger';
import { authorize, requireSurface, requireTenant } from '../middlewares/auth.middleware';
import { idempotency } from '../middlewares/idempotency.middleware';
import type { Database } from '../models/ringpe_models';
import {
  cardSchema,
  cardsQuerySchema,
  cardsSchema,
  cardStatusSchema,
  cardTokenSchema,
  cardWriteSchema,
  cardWrittenSchema,
  kioskSchema,
  lossSchema,
  myCardSchema,
  pairedSchema,
  pairingCodeSchema,
  pairSchema,
  reissuedSchema,
  reissueSchema,
  terminalInputSchema,
  terminalPatchSchema,
  terminalSchema,
  terminalSessionSchema,
  terminalSignInSchema,
  terminalsQuerySchema,
  terminalsSchema,
  terminalStatusSchema,
  TERMINAL_PURPOSES,
  terminalConfigSchema,
} from '../schemas/terminals.schema';
import type { CardsService } from '../services/cards.service';
import type { TerminalsService } from '../services/terminals.service';
import { AuthenticationError } from '../utils/CustomAPIError';
import { expectedVersion, setEtag } from '../utils/etag';

const doc = (tags: string[]) => (d: Omit<Parameters<typeof defineRoute>[0], 'tags'>) =>
  defineRoute({ ...d, tags });
const trm = doc(['Terminals']);
const crd = doc(['Cards']);

trm({
  id: 'INS-030',
  method: 'get',
  path: '/api/v1/console/readers',
  summary: 'Readers and terminals: purpose, binding, status, pairing, last seen',
  auth: 'readers.view',
  responses: { 200: { description: 'Terminals', schema: terminalsSchema } },
});
trm({
  id: 'INS-031',
  method: 'post',
  path: '/api/v1/console/readers',
  summary:
    'Register a reader or POS terminal with its purpose (RC-16) and binding (merchant, section or location type)',
  auth: 'readers.edit',
  request: terminalInputSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Registered' } },
});
trm({
  id: 'INS-032',
  method: 'patch',
  path: '/api/v1/console/readers/{readerId}',
  summary: 'Rename, move or change the purpose; the history is kept (If-Match)',
  auth: 'readers.edit',
  request: terminalPatchSchema,
  responses: { 200: { description: 'Terminal', schema: terminalSchema } },
});
trm({
  id: 'INS-033',
  method: 'post',
  path: '/api/v1/console/readers/{readerId}/pairing-codes',
  summary: 'A one-time pairing code (trm.pairing.minutes); a new code re-pairs the terminal',
  auth: 'readers.edit',
  idempotent: 'required',
  responses: { 201: { description: 'Code', schema: pairingCodeSchema } },
});
trm({
  id: 'INS-034',
  method: 'post',
  path: '/api/v1/console/readers/{readerId}/status',
  summary: 'Disable (with a reason; the device must pair again) or enable a terminal',
  auth: 'readers.edit',
  request: terminalStatusSchema,
  responses: { 200: { description: 'Terminal', schema: terminalSchema } },
});
trm({
  id: 'IDN-040',
  method: 'post',
  path: '/api/v1/terminal/pairing',
  summary:
    'Pair a device with a one-time code: binds the fingerprint and returns the device secret once',
  auth: 'public',
  request: pairSchema,
  responses: { 201: { description: 'Paired', schema: pairedSchema } },
});
trm({
  id: 'IDN-041',
  method: 'post',
  path: '/api/v1/terminal/auth/signin',
  summary:
    'Terminal sign-in: HMAC of "<terminalId>.<nonce>" with the device secret; the nonce is used once; the institution must be active',
  auth: 'public',
  request: terminalSignInSchema,
  responses: { 200: { description: 'Session', schema: terminalSessionSchema } },
});
crd({
  id: 'ATT-003',
  method: 'post',
  path: '/api/v1/terminal/reader/balance-checks',
  summary: 'Balance kiosk: a card tap shows the holder and the campus and allowance balances',
  auth: 'terminal: balance check',
  request: cardTokenSchema,
  responses: { 200: { description: 'Balances', schema: kioskSchema } },
});
crd({
  id: 'ATT-004',
  method: 'post',
  path: '/api/v1/terminal/reader/card-writes',
  summary:
    'Write a card for a member at a card-issue reader (token generated here; a replacement needs a console re-issue)',
  auth: 'terminal: card issue',
  request: cardWriteSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Written', schema: cardWrittenSchema } },
});
trm({
  id: 'ATT-001',
  method: 'get',
  path: '/api/v1/terminal/reader/config',
  summary:
    "The terminal's own identity for its screen: name, location, purpose, bound merchant or class, device fingerprint, the institution (periods and slots arrive with attendance)",
  auth: 'terminal: any purpose',
  responses: { 200: { description: 'Configuration', schema: terminalConfigSchema } },
});
crd({
  id: 'ATT-005',
  method: 'get',
  path: '/api/v1/console/cards',
  summary: 'Cards: member, status, issue reason, re-issues, last tap',
  auth: 'cards.view',
  responses: { 200: { description: 'Cards', schema: cardsSchema } },
});
crd({
  id: 'ATT-006',
  method: 'post',
  path: '/api/v1/console/cards/{cardId}/status',
  summary: 'Block or reactivate a card with a reason (audited; the holder is told)',
  auth: 'cards.edit',
  request: cardStatusSchema,
  responses: { 200: { description: 'Card', schema: cardSchema } },
});
crd({
  id: 'ATT-007',
  method: 'post',
  path: '/api/v1/console/cards/{cardId}/reissue',
  summary:
    'Re-issue: the card is deactivated and a card-issue reader may write a new one (code valid att.cardWrite.minutes)',
  auth: 'cards.edit',
  request: reissueSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Authorised', schema: reissuedSchema } },
});
crd({
  id: 'ATT-024',
  method: 'get',
  path: '/api/v1/me/card',
  summary: 'My campus card (or a child’s with `for`)',
  auth: 'member',
  responses: { 200: { description: 'Card', schema: myCardSchema } },
});
crd({
  id: 'ATT-025',
  method: 'post',
  path: '/api/v1/me/card/loss-reports',
  summary: 'Report the card lost: it is blocked at once',
  auth: 'member',
  request: lossSchema,
  idempotent: 'required',
  responses: { 201: { description: 'Blocked' } },
});

/** Mounted under /api/v1. */
export function terminalsRoutes(deps: {
  db: Kysely<Database>;
  terminals: TerminalsService;
  cards: CardsService;
  loggers: Loggers;
  authLimiter: RequestHandler;
}): Router {
  const router = Router();
  const L = deps.loggers;
  const once = idempotency({ db: deps.db, mode: 'required' });
  const wrap =
    (fn: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (e) {
        next(e);
      }
    };
  const principal = (req: Request) => {
    if (!req.principal) throw new AuthenticationError();
    return req.principal;
  };
  const param = (req: Request, k: string) => String(req.params[k]);
  const console = [requireSurface(L, 'console'), requireTenant(L)];
  const member = requireSurface(L, 'member');
  const terminal = requireSurface(L, 'terminal');

  // --- console: readers ------------------------------------------------------------------------------
  router.get(
    '/console/readers',
    ...console,
    authorize('readers.view', L),
    wrap(async (req, res) => {
      res.json(await deps.terminals.list(principal(req), terminalsQuerySchema.parse(req.query)));
    }),
  );
  router.post(
    '/console/readers',
    ...console,
    authorize('readers.edit', L),
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(
          await deps.terminals.register(principal(req), terminalInputSchema.parse(req.body ?? {})),
        );
    }),
  );
  router.patch(
    '/console/readers/:readerId',
    ...console,
    authorize('readers.edit', L),
    wrap(async (req, res) => {
      const out = await deps.terminals.update(
        principal(req),
        param(req, 'readerId'),
        expectedVersion(req),
        terminalPatchSchema.parse(req.body ?? {}),
      );
      setEtag(res, out.version);
      res.json(out);
    }),
  );
  router.post(
    '/console/readers/:readerId/pairing-codes',
    ...console,
    authorize('readers.edit', L),
    once,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res
        .status(201)
        .json(await deps.terminals.pairingCode(principal(req), param(req, 'readerId')));
    }),
  );
  router.post(
    '/console/readers/:readerId/status',
    ...console,
    authorize('readers.edit', L),
    wrap(async (req, res) => {
      res.json(
        await deps.terminals.setStatus(
          principal(req),
          param(req, 'readerId'),
          terminalStatusSchema.parse(req.body ?? {}),
        ),
      );
    }),
  );

  // --- devices -----------------------------------------------------------------------------------------
  router.post(
    '/terminal/pairing',
    deps.authLimiter,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(await deps.terminals.pair(pairSchema.parse(req.body ?? {})));
    }),
  );
  router.post(
    '/terminal/auth/signin',
    deps.authLimiter,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.terminals.signIn(terminalSignInSchema.parse(req.body ?? {})));
    }),
  );
  router.get(
    '/terminal/reader/config',
    terminal,
    wrap(async (req, res) => {
      const t = await deps.terminals.caller(req, TERMINAL_PURPOSES);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.terminals.config(t));
    }),
  );
  router.post(
    '/terminal/reader/balance-checks',
    terminal,
    wrap(async (req, res) => {
      const t = await deps.terminals.caller(req, ['BALANCE_CHECK']);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await deps.cards.kiosk(t, cardTokenSchema.parse(req.body ?? {})));
    }),
  );
  router.post(
    '/terminal/reader/card-writes',
    terminal,
    once,
    wrap(async (req, res) => {
      const t = await deps.terminals.caller(req, ['CARD_ISSUE']);
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(await deps.cards.write(t, cardWriteSchema.parse(req.body ?? {})));
    }),
  );

  // --- console: cards ---------------------------------------------------------------------------------
  router.get(
    '/console/cards',
    ...console,
    authorize('cards.view', L),
    wrap(async (req, res) => {
      res.json(await deps.cards.list(principal(req), cardsQuerySchema.parse(req.query)));
    }),
  );
  router.post(
    '/console/cards/:cardId/status',
    ...console,
    authorize('cards.edit', L),
    wrap(async (req, res) => {
      res.json(
        await deps.cards.setStatus(
          principal(req),
          param(req, 'cardId'),
          cardStatusSchema.parse(req.body ?? {}),
        ),
      );
    }),
  );
  router.post(
    '/console/cards/:cardId/reissue',
    ...console,
    authorize('cards.edit', L),
    once,
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res
        .status(201)
        .json(
          await deps.cards.reissue(
            principal(req),
            param(req, 'cardId'),
            reissueSchema.parse(req.body ?? {}),
          ),
        );
    }),
  );

  // --- member -----------------------------------------------------------------------------------------
  router.get(
    '/me/card',
    member,
    wrap(async (req, res) => {
      const forProfile = typeof req.query['for'] === 'string' ? req.query['for'] : undefined;
      res.json(await deps.cards.myCard(principal(req), forProfile));
    }),
  );
  router.post(
    '/me/card/loss-reports',
    member,
    once,
    wrap(async (req, res) => {
      res
        .status(201)
        .json(await deps.cards.reportLost(principal(req), lossSchema.parse(req.body ?? {})));
    }),
  );
  return router;
}
