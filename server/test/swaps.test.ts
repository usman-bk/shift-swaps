import { Shift, Swap } from '../src/models';
import { Problem } from '../src/problem';
import * as swaps from '../src/swaps';
import { acceptedSwap, barrier, hooks, hour, ownerOf, person, shift, shiftsOf, useDatabase } from './helpers';

useDatabase();

const code = (e: unknown) => (e instanceof Problem ? e.code : String(e));
const failsWith = (c: string) => expect.objectContaining({ code: c });

describe('offering a shift', () => {
  it('opens a swap on your own shift', async () => {
    const a = await person();
    const s = await shift(a, 9, 17);
    const swap = await swaps.offer(String(s._id), a, hooks);
    expect(swap.status).toBe('open');
  });

  it('refuses someone else’s shift', async () => {
    const [a, b] = [await person(), await person()];
    const s = await shift(a, 9, 17);
    await expect(swaps.offer(String(s._id), b, hooks)).rejects.toEqual(failsWith('not_your_shift'));
  });

  it('refuses a shift that has started', async () => {
    const a = await person();
    const s = await shift(a, 9, 17);
    await expect(swaps.offer(String(s._id), a, { now: () => hour(10) })).rejects.toEqual(
      failsWith('shift_has_started'),
    );
  });

  it('returns the same swap when the request is retried, even at the same moment', async () => {
    const a = await person();
    const s = await shift(a, 9, 17);
    const results = await Promise.all(Array.from({ length: 8 }, () => swaps.offer(String(s._id), a, hooks)));
    expect(new Set(results.map((r) => String(r._id))).size).toBe(1);
    expect(await Swap.countDocuments({})).toBe(1);
  });

  it('can offer a shift again once the earlier swap has closed', async () => {
    const a = await person();
    const s = await shift(a, 9, 17);
    const first = await swaps.offer(String(s._id), a, hooks);
    await swaps.cancel(String(first._id), a, hooks);
    const second = await swaps.offer(String(s._id), a, hooks);
    expect(String(second._id)).not.toBe(String(first._id));
  });

  it('refuses a shift already given back in another swap', async () => {
    const [a, b] = [await person(), await person()];
    const offered = await shift(a, 9, 17);
    const given = await shift(b, 40, 48);
    const swap = await swaps.offer(String(offered._id), a, hooks);
    await swaps.accept(String(swap._id), String(given._id), b, hooks);
    await expect(swaps.offer(String(given._id), b, hooks)).rejects.toEqual(
      failsWith('shift_in_another_swap'),
    );
  });
});

describe('accepting a swap', () => {
  it('lets exactly one of many people take it', async () => {
    const a = await person();
    const s = await shift(a, 9, 17);
    const swap = await swaps.offer(String(s._id), a, hooks);
    const takers = await Promise.all(Array.from({ length: 10 }, () => person()));
    const results = await Promise.allSettled(
      takers.map((t) => swaps.accept(String(swap._id), null, t, hooks)),
    );
    const lost = results.filter((r) => r.status === 'rejected');
    expect(results.length - lost.length).toBe(1);
    expect(lost.map((r) => code(r.reason as unknown))).toEqual(Array(9).fill('already_taken'));
  });

  it('treats the winner retrying as success', async () => {
    const [a, b] = [await person(), await person()];
    const s = await shift(a, 9, 17);
    const swap = await swaps.offer(String(s._id), a, hooks);
    await swaps.accept(String(swap._id), null, b, hooks);
    const again = await swaps.accept(String(swap._id), null, b, hooks);
    expect(again.status).toBe('accepted');
  });

  it('refuses your own swap', async () => {
    const a = await person();
    const s = await shift(a, 9, 17);
    const swap = await swaps.offer(String(s._id), a, hooks);
    await expect(swaps.accept(String(swap._id), null, a, hooks)).rejects.toEqual(failsWith('own_swap'));
  });

  it('refuses early when the taker is already working then', async () => {
    const [a, b] = [await person(), await person()];
    const s = await shift(a, 9, 17);
    await shift(b, 12, 20);
    const swap = await swaps.offer(String(s._id), a, hooks);
    await expect(swaps.accept(String(swap._id), null, b, hooks)).rejects.toEqual(
      failsWith('would_double_book'),
    );
    expect((await Swap.findById(swap._id))!.status).toBe('open');
  });

  it('will not let one shift be given back in two swaps at once', async () => {
    const [a, c, b] = [await person(), await person(), await person()];
    const s1 = await shift(a, 9, 17);
    const s2 = await shift(c, 200, 208);
    const given = await shift(b, 400, 408);
    const swap1 = await swaps.offer(String(s1._id), a, hooks);
    const swap2 = await swaps.offer(String(s2._id), c, hooks);
    const results = await Promise.allSettled([
      swaps.accept(String(swap1._id), String(given._id), b, hooks),
      swaps.accept(String(swap2._id), String(given._id), b, hooks),
    ]);
    const lost = results.filter((r) => r.status === 'rejected');
    expect(lost).toHaveLength(1);
    expect(code(lost[0]!.reason as unknown)).toBe('shift_in_another_swap');
  });
});

describe('approving a swap', () => {
  it('moves the shift to the taker', async () => {
    const [m, a, b] = [await person('manager'), await person(), await person()];
    const s = await shift(a, 9, 17);
    const id = await acceptedSwap(a, s, b);
    const done = await swaps.approve(id, m, hooks);
    expect(done.status).toBe('approved');
    expect(done.locks).toHaveLength(0);
    expect((await ownerOf(s)).equals(b.id)).toBe(true);
  });

  it('exchanges both shifts in a trade', async () => {
    const [m, a, b] = [await person('manager'), await person(), await person()];
    const s = await shift(a, 9, 17);
    const given = await shift(b, 40, 48);
    const swap = await swaps.offer(String(s._id), a, hooks);
    await swaps.accept(String(swap._id), String(given._id), b, hooks);
    await swaps.approve(String(swap._id), m, hooks);
    expect((await ownerOf(s)).equals(b.id)).toBe(true);
    expect((await ownerOf(given)).equals(a.id)).toBe(true);
  });

  it('allows a trade of two overlapping shifts, since each person gives one up', async () => {
    const [m, a, b] = [await person('manager'), await person(), await person()];
    const s = await shift(a, 9, 17);
    const given = await shift(b, 10, 18);
    const swap = await swaps.offer(String(s._id), a, hooks);
    await swaps.accept(String(swap._id), String(given._id), b, hooks);
    await expect(swaps.approve(String(swap._id), m, hooks)).resolves.toBeDefined();
  });

  it('is managers only', async () => {
    const [a, b] = [await person(), await person()];
    const s = await shift(a, 9, 17);
    const id = await acceptedSwap(a, s, b);
    await expect(swaps.approve(id, b, hooks)).rejects.toEqual(failsWith('managers_only'));
    expect((await ownerOf(s)).equals(a.id)).toBe(true);
  });

  it('a second approval changes nothing and still succeeds', async () => {
    const [m, a, b] = [await person('manager'), await person(), await person()];
    const s = await shift(a, 9, 17);
    const id = await acceptedSwap(a, s, b);
    await swaps.approve(id, m, hooks);
    const again = await swaps.approve(id, m, hooks);
    expect(again.history.filter((h) => h.action === 'approved')).toHaveLength(1);
  });

  it('re-checks the rota, because it can change after the accept', async () => {
    const [m, a, b] = [await person('manager'), await person(), await person()];
    const s = await shift(a, 9, 17);
    const id = await acceptedSwap(a, s, b);
    await shift(b, 12, 20);
    await expect(swaps.approve(id, m, hooks)).rejects.toEqual(failsWith('would_double_book'));
    expect((await ownerOf(s)).equals(a.id)).toBe(true);
    expect((await Swap.findById(id))!.status).toBe('accepted');
  });

  it('refuses when the shift has changed hands', async () => {
    const [m, a, b, c] = [await person('manager'), await person(), await person(), await person()];
    const s = await shift(a, 9, 17);
    const id = await acceptedSwap(a, s, b);
    await Shift.updateOne({ _id: s._id }, { owner: c.id });
    await expect(swaps.approve(id, m, hooks)).rejects.toEqual(failsWith('owner_changed'));
  });

  it('refuses once the shift has started', async () => {
    const [m, a, b] = [await person('manager'), await person(), await person()];
    const s = await shift(a, 9, 17);
    const id = await acceptedSwap(a, s, b);
    await expect(swaps.approve(id, m, { now: () => hour(9) })).rejects.toEqual(
      failsWith('shift_has_started'),
    );
  });

  it('refuses a swap nobody has accepted', async () => {
    const [m, a] = [await person('manager'), await person()];
    const s = await shift(a, 9, 17);
    const swap = await swaps.offer(String(s._id), a, hooks);
    await expect(swaps.approve(String(swap._id), m, hooks)).rejects.toEqual(failsWith('wrong_state'));
  });
});

describe('rest between shifts', () => {
  async function takerWith(existing: [number, number], incoming: [number, number]) {
    const [a, b] = [await person(), await person()];
    await shift(b, ...existing);
    const s = await shift(a, ...incoming);
    const swap = await swaps.offer(String(s._id), a, hooks);
    return { b, swap };
  }

  it('refuses ten hours and fifty nine minutes', async () => {
    const { b, swap } = await takerWith([9, 17], [17 + 10 + 59 / 60, 36]);
    await expect(swaps.accept(String(swap._id), null, b, hooks)).rejects.toEqual(
      failsWith('too_little_rest'),
    );
  });

  it('allows exactly eleven hours', async () => {
    const { b, swap } = await takerWith([9, 17], [28, 36]);
    await expect(swaps.accept(String(swap._id), null, b, hooks)).resolves.toBeDefined();
  });

  it('checks the rest before the incoming shift as well as after it', async () => {
    const { b, swap } = await takerWith([28, 36], [9, 18]);
    await expect(swaps.accept(String(swap._id), null, b, hooks)).rejects.toEqual(
      failsWith('too_little_rest'),
    );
  });

  it('counts real hours across the night the clocks go back', async () => {
    // Berlin, 25 October 2026. 22:00 Saturday to 08:00 Sunday reads as ten
    // hours on the wall and is eleven in fact.
    const [a, b] = [await person(), await person()];
    const clock = { now: () => new Date('2026-10-24T00:00:00Z') };
    await Shift.create({
      title: 'Late',
      owner: b.id,
      start: new Date('2026-10-24T12:00:00Z'),
      end: new Date('2026-10-24T20:00:00Z'),
    });
    const s = await Shift.create({
      title: 'Early',
      owner: a.id,
      start: new Date('2026-10-25T07:00:00Z'),
      end: new Date('2026-10-25T15:00:00Z'),
    });
    const swap = await swaps.offer(String(s._id), a, clock);
    await expect(swaps.accept(String(swap._id), null, b, clock)).resolves.toBeDefined();
  });
});

describe('two approvals racing', () => {
  it('cannot double book one person, even though each transaction alone looks valid', async () => {
    const [m, a, c, b] = [await person('manager'), await person(), await person(), await person()];
    const s1 = await shift(a, 9, 17);
    const s2 = await shift(c, 10, 18);
    const id1 = await acceptedSwap(a, s1, b);
    const id2 = await acceptedSwap(c, s2, b);

    const meet = barrier(800);
    const race = { ...hooks, afterChecks: meet };
    const results = await Promise.allSettled([swaps.approve(id1, m, race), swaps.approve(id2, m, race)]);

    const lost = results.filter((r) => r.status === 'rejected');
    expect(lost).toHaveLength(1);
    expect(code(lost[0]!.reason as unknown)).toBe('would_double_book');
    expect(await shiftsOf(b)).toBe(1);
  }, 30_000);

  it('cancelling during an approval leaves the shift where it was', async () => {
    const [m, a, b] = [await person('manager'), await person(), await person()];
    const s = await shift(a, 9, 17);
    const id = await acceptedSwap(a, s, b);
    let cancelled = false;
    const approval = swaps.approve(id, m, {
      ...hooks,
      afterChecks: async () => {
        if (cancelled) return;
        cancelled = true;
        await swaps.cancel(id, a, hooks);
      },
    });
    await expect(approval).rejects.toEqual(failsWith('wrong_state'));
    expect((await Swap.findById(id))!.status).toBe('cancelled');
    expect((await ownerOf(s)).equals(a.id)).toBe(true);
  }, 30_000);

  it('a shift can be swapped on again once the first swap has closed', async () => {
    const [m, a, b, c] = [await person('manager'), await person(), await person(), await person()];
    const s = await shift(a, 9, 17);
    const given = await shift(b, 100, 108);
    const swap = await swaps.offer(String(s._id), a, hooks);
    await swaps.accept(String(swap._id), String(given._id), b, hooks);
    await swaps.approve(String(swap._id), m, hooks);
    const next = await swaps.offer(String(given._id), a, hooks);
    await swaps.accept(String(next._id), null, c, hooks);
    await swaps.approve(String(next._id), m, hooks);
    expect((await ownerOf(given)).equals(c.id)).toBe(true);
  });
});

describe('closing a swap', () => {
  it('only the person who offered can cancel', async () => {
    const [a, b] = [await person(), await person()];
    const s = await shift(a, 9, 17);
    const swap = await swaps.offer(String(s._id), a, hooks);
    await expect(swaps.cancel(String(swap._id), b, hooks)).rejects.toEqual(failsWith('not_your_shift'));
  });

  it('cannot cancel an approved swap', async () => {
    const [m, a, b] = [await person('manager'), await person(), await person()];
    const s = await shift(a, 9, 17);
    const id = await acceptedSwap(a, s, b);
    await swaps.approve(id, m, hooks);
    await expect(swaps.cancel(id, a, hooks)).rejects.toEqual(failsWith('wrong_state'));
  });

  it('declining frees a shift given back, so it can be offered', async () => {
    const [m, a, b] = [await person('manager'), await person(), await person()];
    const s = await shift(a, 9, 17);
    const given = await shift(b, 40, 48);
    const swap = await swaps.offer(String(s._id), a, hooks);
    await swaps.accept(String(swap._id), String(given._id), b, hooks);
    await swaps.decline(String(swap._id), m, hooks);
    await expect(swaps.offer(String(given._id), b, hooks)).resolves.toBeDefined();
  });

  it('decline is managers only', async () => {
    const [a, b] = [await person(), await person()];
    const s = await shift(a, 9, 17);
    const id = await acceptedSwap(a, s, b);
    await expect(swaps.decline(id, b, hooks)).rejects.toEqual(failsWith('managers_only'));
  });
});

describe('the list', () => {
  async function many(count: number) {
    const a = await person();
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const s = await shift(a, 24 * i + 9, 24 * i + 17);
      out.push(String((await swaps.offer(String(s._id), a, hooks))._id));
    }
    return { a, ids: out };
  }

  it('walks every swap once, newest first', async () => {
    const { ids } = await many(45);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof swaps.list>> = await swaps.list('open', cursor);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.next;
    } while (cursor);
    expect(seen).toEqual([...ids].reverse());
  });

  it('a swap added between pages does not repeat a row', async () => {
    const { a, ids } = await many(21);
    const first = await swaps.list('open', null);
    const s = await shift(a, 2000, 2008);
    await swaps.offer(String(s._id), a, hooks);
    const second = await swaps.list('open', first.next);
    expect(second.items.map((i) => i.id)).toEqual([ids[0]]);
  });

  it('filters by state', async () => {
    const [a, b] = [await person(), await person()];
    const s1 = await shift(a, 9, 17);
    const s2 = await shift(a, 100, 108);
    const swap1 = await swaps.offer(String(s1._id), a, hooks);
    await swaps.offer(String(s2._id), a, hooks);
    await swaps.accept(String(swap1._id), null, b, hooks);
    expect((await swaps.list('accepted', null)).items.map((i) => i.id)).toEqual([String(swap1._id)]);
    expect((await swaps.list('open', null)).items).toHaveLength(1);
    expect((await swaps.list('closed', null)).items).toHaveLength(0);
  });

  it('my shifts says which are tied up in a swap', async () => {
    const a = await person();
    const s = await shift(a, 9, 17);
    const free = await shift(a, 100, 108);
    const swap = await swaps.offer(String(s._id), a, hooks);
    const rows = await swaps.myShifts(a, hooks);
    expect(rows.find((r) => r.id === String(s._id))!.swapId).toBe(String(swap._id));
    expect(rows.find((r) => r.id === String(free._id))!.swapId).toBeNull();
  });
});
