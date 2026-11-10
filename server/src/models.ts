import { model, Schema, Types } from 'mongoose';

export type Role = 'staff' | 'manager';
export type SwapStatus = 'open' | 'accepted' | 'approved' | 'declined' | 'cancelled';

const userSchema = new Schema({
  email: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['staff', 'manager'], required: true },
  // Nothing reads this number. Writing it is what makes two transactions that
  // change one person's rota collide. See approve() in swaps.ts.
  rotaVersion: { type: Number, default: 0 },
});

const shiftSchema = new Schema({
  title: { type: String, required: true },
  start: { type: Date, required: true },
  end: { type: Date, required: true },
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
});
shiftSchema.index({ owner: 1, start: 1 });

const eventSchema = new Schema(
  {
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true },
  },
  { _id: false },
);

const swapSchema = new Schema({
  requester: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  taker: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  shift: { type: Schema.Types.ObjectId, ref: 'Shift', required: true },
  // Set when the taker gives one of their own shifts in return.
  back: { type: Schema.Types.ObjectId, ref: 'Shift', default: null },
  status: {
    type: String,
    enum: ['open', 'accepted', 'approved', 'declined', 'cancelled'],
    required: true,
  },
  // Shifts this swap has a claim on. Emptied when the swap closes.
  locks: { type: [Schema.Types.ObjectId], default: [] },
  live: { type: Boolean, default: true },
  // Bounded by the state machine: a swap has at most four events.
  history: { type: [eventSchema], default: [] },
});

// A unique index on an array is unique across documents, so one shift can sit
// in only one live swap, whichever side of the swap it is on.
swapSchema.index({ locks: 1 }, { unique: true, partialFilterExpression: { live: true } });
swapSchema.index({ status: 1, _id: -1 });

export const User = model('User', userSchema);
export const Shift = model('Shift', shiftSchema);
export const Swap = model('Swap', swapSchema);

export type Id = Types.ObjectId;

export async function ensureIndexes(): Promise<void> {
  await Promise.all([User.createCollection(), Shift.createCollection(), Swap.createCollection()]);
  await Promise.all([User.syncIndexes(), Shift.syncIndexes(), Swap.syncIndexes()]);
}
