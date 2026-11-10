import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me, MyShift, SwapView } from '../src/api';
import { App } from '../src/App';
import { span } from '../src/format';
import { makeStore } from '../src/store';

const TZ = 'Europe/Berlin';
const staff: Me = { id: 'u1', name: 'Jonas Weber', role: 'staff', timeZone: TZ };
const manager: Me = { id: 'u9', name: 'Mina Vogel', role: 'manager', timeZone: TZ };
const shift = { id: 's1', title: 'Kitchen', start: '2030-03-04T08:00:00Z', end: '2030-03-04T16:00:00Z' };

function swap(over: Partial<SwapView> = {}): SwapView {
  return {
    id: 'w1',
    status: 'open',
    requester: { id: 'u2', name: 'Priya Nair' },
    taker: null,
    shift,
    back: null,
    ...over,
  };
}

type Reply = { status: number; body?: unknown };
type Handler = (url: URL, body: unknown) => Reply | Promise<Reply>;

const calls: { method: string; path: string; search: string; body: unknown }[] = [];
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

function serve(
  opts: {
    me?: Me | null;
    swaps?: SwapView[];
    shifts?: MyShift[];
    routes?: Record<string, Handler>;
    list?: Handler;
  } = {},
) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request) => {
      const url = new URL(input.url);
      const path = url.pathname.replace('/api', '');
      const text = input.method === 'POST' ? await input.text() : '';
      const body: unknown = text ? JSON.parse(text) : undefined;
      calls.push({ method: input.method, path, search: url.search, body });
      const key = `${input.method} ${path}`;
      const route = opts.routes?.[key];
      let reply: Reply;
      if (route) reply = await route(url, body);
      else if (key === 'GET /me') {
        reply = opts.me ? { status: 200, body: opts.me } : { status: 401, body: { code: 'not_signed_in' } };
      } else if (key === 'GET /shifts/mine') reply = { status: 200, body: opts.shifts ?? [] };
      else if (key === 'GET /swaps') {
        reply = opts.list
          ? await opts.list(url, body)
          : { status: 200, body: { items: opts.swaps ?? [], next: null } };
      } else reply = { status: 200, body: {} };
      return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function open() {
  render(
    <Provider store={makeStore()}>
      <App />
    </Provider>,
  );
  return userEvent.setup();
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const row = async (text: string) => (await screen.findByText(text)).closest('li')!;

beforeEach(() => vi.unstubAllGlobals());

describe('signing in', () => {
  it('shows the sign-in form when there is no session', async () => {
    serve();
    open();
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });

  it('says why a sign-in failed', async () => {
    serve({
      routes: { 'POST /auth/login': () => ({ status: 401, body: { message: 'Wrong email or password.' } }) },
    });
    const user = open();
    await user.type(await screen.findByLabelText('Email'), 'a@example.com');
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Wrong email or password.')).toBeInTheDocument();
  });

  it('goes back to sign-in when the session runs out mid-task', async () => {
    let expired = false;
    serve({
      swaps: [swap({ requester: { id: 'u1', name: 'Jonas Weber' } })],
      routes: {
        'GET /me': () => (expired ? { status: 401, body: {} } : { status: 200, body: staff }),
        'POST /swaps/w1/cancel': () => {
          expired = true;
          return { status: 401, body: { message: 'Please sign in.' } };
        },
      },
    });
    const user = open();
    await user.click(within(await row('Kitchen')).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });
});

describe('who can do what', () => {
  it('staff can accept someone else’s swap and cannot approve', async () => {
    serve({ me: staff, swaps: [swap()] });
    open();
    const li = await row('Kitchen');
    expect(within(li).getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(within(li).queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('staff cannot approve or decline a swap that is waiting for a manager', async () => {
    serve({ me: staff, swaps: [swap({ status: 'accepted', taker: { id: 'u3', name: 'Tom Becker' } })] });
    open();
    const li = await row('Kitchen');
    expect(within(li).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(li).queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  it('you cancel your own swap rather than accept it', async () => {
    serve({ me: staff, swaps: [swap({ requester: { id: 'u1', name: 'Jonas Weber' } })] });
    open();
    const li = await row('Kitchen');
    expect(within(li).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(li).queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('a manager approves or declines only what has been accepted', async () => {
    serve({
      me: manager,
      swaps: [
        swap({ status: 'accepted', taker: { id: 'u3', name: 'Tom Becker' } }),
        swap({ id: 'w2', shift: { ...shift, id: 's2', title: 'Delivery' } }),
      ],
    });
    open();
    expect(within(await row('Kitchen')).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    const open2 = await row('Delivery');
    expect(within(open2).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(open2).queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('a closed swap offers no actions', async () => {
    serve({ me: staff, swaps: [swap({ status: 'approved' })] });
    open();
    expect(within(await row('Kitchen')).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('accepting', () => {
  async function acceptFirst(user: ReturnType<typeof userEvent.setup>) {
    await user.click(within(await row('Kitchen')).getByRole('button', { name: 'Accept' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByRole('button', { name: 'Accept', hidden: true }));
  }

  it('shows as accepted before the server answers', async () => {
    const gate = deferred<Reply>();
    serve({ me: staff, swaps: [swap()], routes: { 'POST /swaps/w1/accept': () => gate.promise } });
    const user = open();
    await acceptFirst(user);
    const li = await row('Kitchen');
    expect(await within(li).findByText('Waiting for approval')).toBeInTheDocument();
    expect(within(li).getByText(/to Jonas Weber/)).toBeInTheDocument();
    gate.resolve({ status: 200, body: swap({ status: 'accepted' }) });
  });

  it('puts the row back and gives the server’s reason when someone got there first', async () => {
    const gate = deferred<Reply>();
    serve({ me: staff, swaps: [swap()], routes: { 'POST /swaps/w1/accept': () => gate.promise } });
    const user = open();
    await acceptFirst(user);
    await screen.findByText('Waiting for approval');
    gate.resolve({ status: 409, body: { message: 'Someone else has already taken this swap.' } });
    expect(await screen.findByText('Someone else has already taken this swap.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Open', { selector: '.tag' })).toBeInTheDocument());
    expect(screen.queryByText('Waiting for approval')).toBeNull();
  });

  it('puts the row back straight away, without waiting for the refetch', async () => {
    const accept = deferred<Reply>();
    const refetch = deferred<Reply>();
    let lists = 0;
    serve({
      me: staff,
      list: () => {
        lists += 1;
        return lists === 1 ? { status: 200, body: { items: [swap()], next: null } } : refetch.promise;
      },
      routes: { 'POST /swaps/w1/accept': () => accept.promise },
    });
    const user = open();
    await acceptFirst(user);
    await screen.findByText('Waiting for approval');
    accept.resolve({ status: 409, body: { message: 'Someone else has already taken this swap.' } });
    await screen.findByText('Someone else has already taken this swap.');
    await waitFor(() => expect(lists).toBe(2));
    expect(screen.getByText('Open', { selector: '.tag' })).toBeInTheDocument();
    refetch.resolve({ status: 200, body: { items: [swap()], next: null } });
  });

  it('offers only shifts that are free to give back, and sends the one chosen', async () => {
    const free: MyShift = {
      id: 'mine1',
      title: 'Front desk',
      start: '2030-03-06T08:00:00Z',
      end: '2030-03-06T16:00:00Z',
      swapId: null,
    };
    const tied: MyShift = { ...free, id: 'mine2', title: 'Late desk', swapId: 'w7' };
    serve({ me: staff, swaps: [swap()], shifts: [free, tied] });
    const user = open();
    await screen.findAllByText('Front desk');
    await user.click(within(await row('Kitchen')).getByRole('button', { name: 'Accept' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    expect(within(dialog).queryByText(/Late desk/)).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: /Front desk/, hidden: true }));
    await user.click(within(dialog).getByRole('button', { name: 'Accept', hidden: true }));
    await waitFor(() => expect(posts('/swaps/w1/accept')).toHaveLength(1));
    expect(posts('/swaps/w1/accept')[0]!.body).toEqual({ backShiftId: 'mine1' });
  });

  it('Keep looking closes the dialog and sends nothing', async () => {
    serve({ me: staff, swaps: [swap()] });
    const user = open();
    await user.click(within(await row('Kitchen')).getByRole('button', { name: 'Accept' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByRole('button', { name: 'Keep looking', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).toBeNull());
    expect(posts('/swaps/w1/accept')).toHaveLength(0);
  });
});

describe('pressing twice', () => {
  it('a double click on Approve sends one request', async () => {
    const gate = deferred<Reply>();
    serve({
      me: manager,
      swaps: [swap({ status: 'accepted', taker: { id: 'u3', name: 'Tom Becker' } })],
      routes: { 'POST /swaps/w1/approve': () => gate.promise },
    });
    const user = open();
    await user.dblClick(within(await row('Kitchen')).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posts('/swaps/w1/approve')).toHaveLength(1));
    gate.resolve({ status: 200, body: swap({ status: 'approved' }) });
    await waitFor(() => expect(calls.filter((c) => c.path === '/swaps').length).toBeGreaterThan(1));
    expect(posts('/swaps/w1/approve')).toHaveLength(1);
  });
});

describe('my shifts', () => {
  const mine: MyShift = { ...shift, id: 'm1', title: 'Front desk', swapId: null };

  it('offers a shift', async () => {
    serve({ me: staff, shifts: [mine] });
    const user = open();
    await user.click(await screen.findByRole('button', { name: 'Offer Front desk' }));
    await waitFor(() => expect(posts('/swaps')).toHaveLength(1));
    expect(posts('/swaps')[0]!.body).toEqual({ shiftId: 'm1' });
  });

  it('a shift in a swap cannot be offered again', async () => {
    serve({ me: staff, shifts: [{ ...mine, swapId: 'w1' }] });
    open();
    expect(await screen.findByText('In a swap')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Offer Front desk' })).toBeNull();
  });

  it('a manager has no shift column', async () => {
    serve({ me: manager });
    open();
    await screen.findByText('Swaps');
    expect(screen.queryByText('My shifts')).toBeNull();
  });
});

describe('the list', () => {
  it('asks the server for the chosen filter and marks it pressed', async () => {
    serve({ me: staff, swaps: [swap()] });
    const user = open();
    await row('Kitchen');
    const button = screen.getByRole('button', { name: 'To approve' });
    await user.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(calls.some((c) => c.search === '?filter=accepted')).toBe(true));
  });

  it('Show more appends the next page and goes away at the end', async () => {
    const second = swap({ id: 'w2', shift: { ...shift, id: 's2', title: 'Delivery' } });
    serve({
      me: staff,
      list: (url) =>
        url.searchParams.get('cursor') === 'w1'
          ? { status: 200, body: { items: [second], next: null } }
          : { status: 200, body: { items: [swap()], next: 'w1' } },
    });
    const user = open();
    await row('Kitchen');
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Delivery')).toBeInTheDocument();
    expect(screen.getByText('Kitchen')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull());
  });

  it('says so when there is nothing to show', async () => {
    serve({ me: staff, swaps: [] });
    open();
    expect(await screen.findByText('Nothing here right now.')).toBeInTheDocument();
  });
});

describe('times', () => {
  it('shows the team’s clock, not the browser’s', () => {
    expect(span('2030-03-04T08:00:00Z', '2030-03-04T16:00:00Z', 'Europe/Berlin')).toBe(
      'Mon 4 Mar, 09:00 to 17:00',
    );
    expect(span('2030-03-04T08:00:00Z', '2030-03-04T16:00:00Z', 'Asia/Karachi')).toBe(
      'Mon 4 Mar, 13:00 to 21:00',
    );
  });

  it('marks a shift that ends the next day', () => {
    expect(span('2030-03-04T21:00:00Z', '2030-03-05T05:00:00Z', 'Europe/Berlin')).toBe(
      'Mon 4 Mar, 22:00 to 06:00 next day',
    );
  });
});
