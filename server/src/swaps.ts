import mongoose, { ClientSession, isValidObjectId } from 'mongoose';
import { Id, Shift, Swap, SwapStatus, User } from './models';
import { Problem } from './problem';

export const MIN_REST_HOURS = Number(process.env.MIN_REST_HOURS ?? 11);
const REST_MS = MIN_REST_HOURS * 3_600_000;
const PAGE = 20;

export type Actor = { id: Id; role: 'staff' | 'manager' };
export type Filter = 'open' | 'accepted' | 'closed' | 'all';

/** Seams the tests use to line two requests up on purpose. */
export type Hooks = { now?: () => Date; afterChecks?: () => Promise<void> };

const DUPLICATE_KEY = 11000;
const event = (by: Id, action: string, at: Date) => ({ at, by, action });
const isDuplicate = (e: unknown) => (e as { code?: number }).code === DUPLICATE_KEY;

async function mustFindOwnShift(shiftId: string, actor: Actor, now: Date) {
  const shift = isValidObjectId(shiftId) ? await Shift.findById(shiftId).lean() : null;
  if (!shift) throw new Problem(404, 'not_found', 'That shift does not exist.');
  if (!shift.owner.equals(actor.id)) {
    throw new Problem(403, 'not_your_shift', 'That shift belongs to someone else.');
  }
  if (shift.start <= now) throw new Problem(409, 'shift_has_started', 'That shift has started.');
  return shift;
}

/** Throws if `person`, having lost `leaving`, could not also work `incoming`. */
async function checkRota(
  person: Id,
  incoming: { start: Date; end: Date },
  leaving: Id | null,
  session: ClientSession | null,
): Promise<void> {
  const neighbours = await Shift.find({
    owner: person,
    ...(leaving ? { _id: { $ne: leaving } } : {}),
    start: { $lt: new Date(incoming.end.getTime() + REST_MS) },
    end: { $gt: new Date(incoming.start.getTime() - REST_MS) },
  })
    .session(session)
    .lean();
  if (neighbours.length === 0) return;
  const overlaps = neighbours.some((s) => s.start < incoming.end && s.end > incoming.start);
  if (overlaps) {
    throw new Problem(409, 'would_double_book', 'This swap would put someone on two shifts at once.');
  }
  throw new Problem(
    409,
    'too_little_rest',
    `This swap would leave someone less than ${MIN_REST_HOURS} hours between shifts.`,
  );
}

export async function offer(shiftId: string, actor: Actor, hooks: Hooks = {}) {
  const at = hooks.now?.() ?? new Date();
  const shift = await mustFindOwnShift(shiftId, actor, at);
  try {
    return await Swap.create({
      requester: actor.id,
      shift: shift._id,
      status: 'open',
      locks: [shift._id],
      history: [event(actor.id, 'offered', at)],
    });
  } catch (e) {
    if (!isDuplicate(e)) throw e;
    // A retry of an offer that got through returns that offer. Anything else
    // holding the lock is a swap this shift was given back in.
    const live = await Swap.findOne({ live: true, locks: shift._id });
    if (live && live.shift.equals(shift._id) && live.requester.equals(actor.id)) return live;
    throw new Problem(409, 'shift_in_another_swap', 'That shift is already part of another swap.');
  }
}

export async function accept(swapId: string, backShiftId: string | null, actor: Actor, hooks: Hooks = {}) {
  const at = hooks.now?.() ?? new Date();
  const swap = isValidObjectId(swapId) ? await Swap.findById(swapId) : null;
  if (!swap) throw new Problem(404, 'not_found', 'That swap does not exist.');
  if (swap.requester.equals(actor.id)) {
    throw new Problem(403, 'own_swap', 'You cannot accept your own swap.');
  }
  if (swap.taker?.equals(actor.id) && swap.status === 'accepted') return swap;

  const shift = await Shift.findById(swap.shift).lean();
  if (!shift) throw new Problem(404, 'not_found', 'That shift does not exist.');
  if (shift.start <= at) throw new Problem(409, 'shift_has_started', 'That shift has started.');

  const back = backShiftId ? await mustFindOwnShift(backShiftId, actor, at) : null;

  // Refuses early so nobody waits on a manager for a swap that cannot pass.
  // approve() checks again, because this answer can go stale.
  await checkRota(actor.id, shift, back?._id ?? null, null);
  if (back) await checkRota(swap.requester, back, shift._id, null);

  try {
    const won = await Swap.findOneAndUpdate(
      { _id: swap._id, status: 'open' },
      {
        $set: { status: 'accepted', taker: actor.id, back: back?._id ?? null },
        ...(back ? { $addToSet: { locks: back._id } } : {}),
        $push: { history: event(actor.id, 'accepted', at) },
      },
      { new: true },
    );
    if (!won) throw new Problem(409, 'already_taken', 'Someone else has already taken this swap.');
    return won;
  } catch (e) {
    if (!isDuplicate(e)) throw e;
    throw new Problem(409, 'shift_in_another_swap', 'That shift is already part of another swap.');
  }
}

export async function approve(swapId: string, actor: Actor, hooks: Hooks = {}) {
  if (actor.role !== 'manager') {
    throw new Problem(403, 'managers_only', 'Only a manager can do that.');
  }
  if (!isValidObjectId(swapId)) throw new Problem(404, 'not_found', 'That swap does not exist.');

  const session = await mongoose.startSession();
  try {
    // A conflicting transaction is aborted rather than made to wait, and
    // withTransaction runs this callback again, so it has to start clean.
    return await session.withTransaction(
      async () => {
        const at = hooks.now?.() ?? new Date();
        const swap = await Swap.findById(swapId).session(session);
        if (!swap) throw new Problem(404, 'not_found', 'That swap does not exist.');
        if (swap.status === 'approved') return swap;
        if (swap.status !== 'accepted' || !swap.taker) {
          throw new Problem(409, 'wrong_state', `This swap is ${swap.status}.`);
        }
        const taker = swap.taker;

        await User.updateMany(
          { _id: { $in: [swap.requester, taker] } },
          { $inc: { rotaVersion: 1 } },
          { session },
        );

        const shift = await Shift.findById(swap.shift).session(session).lean();
        const back = swap.back ? await Shift.findById(swap.back).session(session).lean() : null;
        if (!shift || (swap.back && !back)) {
          throw new Problem(409, 'owner_changed', 'A shift in this swap no longer exists.');
        }
        if (!shift.owner.equals(swap.requester) || (back && !back.owner.equals(taker))) {
          throw new Problem(409, 'owner_changed', 'A shift in this swap has changed hands.');
        }
        if (shift.start <= at || (back && back.start <= at)) {
          throw new Problem(409, 'shift_has_started', 'A shift in this swap has started.');
        }
        await checkRota(taker, shift, back?._id ?? null, session);
        if (back) await checkRota(swap.requester, back, shift._id, session);

        await hooks.afterChecks?.();

        await Shift.updateOne({ _id: shift._id }, { owner: taker }, { session });
        if (back) await Shift.updateOne({ _id: back._id }, { owner: swap.requester }, { session });
        swap.status = 'approved';
        swap.locks = [];
        swap.live = false;
        swap.history.push(event(actor.id, 'approved', at));
        await swap.save({ session });
        return swap;
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
  } finally {
    await session.endSession();
  }
}

async function close(
  swapId: string,
  from: SwapStatus[],
  to: SwapStatus,
  actor: Actor,
  extra: Record<string, unknown>,
  at: Date,
) {
  if (!isValidObjectId(swapId)) throw new Problem(404, 'not_found', 'That swap does not exist.');
  const swap = await Swap.findOneAndUpdate(
    { _id: swapId, status: { $in: from }, ...extra },
    {
      $set: { status: to, locks: [], live: false },
      $push: { history: event(actor.id, to, at) },
    },
    { new: true },
  );
  if (swap) return swap;
  const current = await Swap.findById(swapId).lean();
  if (!current) throw new Problem(404, 'not_found', 'That swap does not exist.');
  if (current.status === to) return Swap.hydrate(current);
  if (!from.includes(current.status)) {
    throw new Problem(409, 'wrong_state', `This swap is ${current.status}.`);
  }
  throw new Problem(403, 'not_your_shift', 'That swap belongs to someone else.');
}

export async function cancel(swapId: string, actor: Actor, hooks: Hooks = {}) {
  const at = hooks.now?.() ?? new Date();
  return close(swapId, ['open', 'accepted'], 'cancelled', actor, { requester: actor.id }, at);
}

export async function decline(swapId: string, actor: Actor, hooks: Hooks = {}) {
  if (actor.role !== 'manager') {
    throw new Problem(403, 'managers_only', 'Only a manager can do that.');
  }
  const at = hooks.now?.() ?? new Date();
  return close(swapId, ['accepted'], 'declined', actor, {}, at);
}

const STATUSES: Record<Filter, SwapStatus[] | null> = {
  open: ['open'],
  accepted: ['accepted'],
  closed: ['approved', 'declined', 'cancelled'],
  all: null,
};

/** Newest first, by keyset: a page does not shift when new swaps arrive. */
export async function list(filter: Filter, cursor: string | null) {
  const statuses = STATUSES[filter];
  const rows = await Swap.find({
    ...(statuses ? { status: { $in: statuses } } : {}),
    ...(cursor ? { _id: { $lt: cursor } } : {}),
  })
    .sort({ _id: -1 })
    .limit(PAGE + 1)
    .populate<{ requester: Person }>('requester', 'name')
    .populate<{ taker: Person | null }>('taker', 'name')
    .populate<{ shift: ShiftRow }>('shift', 'title start end')
    .populate<{ back: ShiftRow | null }>('back', 'title start end')
    .lean();
  const items = rows.slice(0, PAGE).map(present);
  return { items, next: rows.length > PAGE ? String(items[items.length - 1]!.id) : null };
}

type Person = { _id: Id; name: string };
type ShiftRow = { _id: Id; title: string; start: Date; end: Date };

const person = (p: Person) => ({ id: String(p._id), name: p.name });
const shiftView = (s: ShiftRow) => ({
  id: String(s._id),
  title: s.title,
  start: s.start.toISOString(),
  end: s.end.toISOString(),
});

function present(row: {
  _id: Id;
  status: SwapStatus;
  requester: Person;
  taker: Person | null;
  shift: ShiftRow;
  back: ShiftRow | null;
}) {
  return {
    id: String(row._id),
    status: row.status,
    requester: person(row.requester),
    taker: row.taker ? person(row.taker) : null,
    shift: shiftView(row.shift),
    back: row.back ? shiftView(row.back) : null,
  };
}

/** The single row a mutation returns, in the same shape as the list. */
export async function view(id: Id) {
  const row = await Swap.findById(id)
    .populate<{ requester: Person }>('requester', 'name')
    .populate<{ taker: Person | null }>('taker', 'name')
    .populate<{ shift: ShiftRow }>('shift', 'title start end')
    .populate<{ back: ShiftRow | null }>('back', 'title start end')
    .lean();
  if (!row) throw new Problem(404, 'not_found', 'That swap does not exist.');
  return present(row);
}

export async function myShifts(actor: Actor, hooks: Hooks = {}) {
  const now = hooks.now?.() ?? new Date();
  const shifts = await Shift.find({ owner: actor.id, end: { $gt: now } })
    .sort({ start: 1 })
    .limit(100)
    .lean();
  const live = await Swap.find({ live: true, locks: { $in: shifts.map((s) => s._id) } })
    .select('locks')
    .lean();
  const swapByShift = new Map(live.flatMap((s) => s.locks.map((l) => [String(l), String(s._id)])));
  return shifts.map((s) => ({ ...shiftView(s), swapId: swapByShift.get(String(s._id)) ?? null }));
}
