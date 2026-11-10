import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { ErrorRequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { Authed, COOKIE, login, requireUser, SESSION_HOURS } from './auth';
import { Problem } from './problem';
import * as swaps from './swaps';

export type Config = {
  jwtSecret: string;
  timeZone: string;
  secureCookies: boolean;
  webRoot?: string;
  loginLimit?: number;
};

const id = z.string().regex(/^[0-9a-f]{24}$/);
const LoginBody = z.object({ email: z.email(), password: z.string().min(1).max(200) });
const OfferBody = z.object({ shiftId: id });
const AcceptBody = z.object({ backShiftId: id.nullable().default(null) });
const ListQuery = z.object({
  filter: z.enum(['open', 'accepted', 'closed', 'all']).default('all'),
  cursor: id.optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Problem(400, 'bad_request', 'That request is not valid.');
  return result.data;
}

const me = (res: Response) => res.locals.user as Authed;
const param = (raw: string | string[] | undefined) => (typeof raw === 'string' ? raw : '');

export function createApp(config: Config) {
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.get('/health', (_req, res) => void res.json({ ok: true }));

  api.post(
    '/auth/login',
    rateLimit({
      windowMs: 60_000,
      limit: config.loginLimit ?? 10,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    async (req, res) => {
      const { email, password } = parse(LoginBody, req.body);
      const token = await login(email, password, config.jwtSecret);
      res.cookie(COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.secureCookies,
        maxAge: SESSION_HOURS * 3_600_000,
      });
      res.status(204).end();
    },
  );
  api.post('/auth/logout', (_req, res) => {
    res.clearCookie(COOKIE);
    res.status(204).end();
  });

  const authed = express.Router();
  authed.use(requireUser(config.jwtSecret));

  authed.get('/me', (_req, res) => {
    const { actor, name } = me(res);
    res.json({ id: String(actor.id), name, role: actor.role, timeZone: config.timeZone });
  });
  authed.get('/shifts/mine', async (_req, res) => {
    res.json(await swaps.myShifts(me(res).actor));
  });
  authed.get('/swaps', async (req, res) => {
    const { filter, cursor } = parse(ListQuery, req.query);
    res.json(await swaps.list(filter, cursor ?? null));
  });
  authed.post('/swaps', async (req, res) => {
    const { shiftId } = parse(OfferBody, req.body);
    const swap = await swaps.offer(shiftId, me(res).actor);
    res.status(201).json(await swaps.view(swap._id));
  });
  authed.post('/swaps/:id/accept', async (req, res) => {
    const { backShiftId } = parse(AcceptBody, req.body ?? {});
    const swap = await swaps.accept(param(req.params.id), backShiftId, me(res).actor);
    res.json(await swaps.view(swap._id));
  });
  authed.post('/swaps/:id/approve', async (req, res) => {
    const swap = await swaps.approve(param(req.params.id), me(res).actor);
    res.json(await swaps.view(swap._id));
  });
  authed.post('/swaps/:id/decline', async (req, res) => {
    const swap = await swaps.decline(param(req.params.id), me(res).actor);
    res.json(await swaps.view(swap._id));
  });
  authed.post('/swaps/:id/cancel', async (req, res) => {
    const swap = await swaps.cancel(param(req.params.id), me(res).actor);
    res.json(await swaps.view(swap._id));
  });

  api.use(authed);
  api.use((_req, _res, next) => next(new Problem(404, 'not_found', 'No such route.')));
  app.use('/api', api);

  if (config.webRoot) {
    const root = path.resolve(config.webRoot);
    app.use(express.static(root));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(root, 'index.html')));
  }

  const onError: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof Problem) {
      return void res.status(err.status).json({ code: err.code, message: err.message });
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      return void res.status(400).json({ code: 'bad_request', message: 'That request is not valid.' });
    }
    console.error(err);
    res.status(500).json({ code: 'internal', message: 'Something went wrong on our side.' });
  };
  app.use(onError);
  return app;
}
