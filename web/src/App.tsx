import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useDispatch } from 'react-redux';
import { api, reason, type Filter, type Me, type MyShift, type SwapView } from './api';
import { span } from './format';

const {
  useMeQuery,
  useLoginMutation,
  useLogoutMutation,
  useMyShiftsQuery,
  useSwapsInfiniteQuery,
  useOfferMutation,
  useAcceptMutation,
  useApproveMutation,
  useDeclineMutation,
  useCancelMutation,
} = api;

export function App() {
  const me = useMeQuery();
  if (me.data && !me.error) return <Board me={me.data} />;
  if (me.isLoading) return <p className="centre">Loading</p>;
  return <SignIn />;
}

function SignIn() {
  const [login, state] = useLoginMutation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void login({ email, password });
  };
  return (
    <main className="signin">
      <h1>Shift swaps</h1>
      <form onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="primary" disabled={state.isLoading}>
          Sign in
        </button>
        <p className="error" role="alert">
          {state.error ? reason(state.error) : ''}
        </p>
      </form>
    </main>
  );
}

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'accepted', label: 'To approve' },
  { value: 'closed', label: 'Closed' },
];

const STATUS_LABEL: Record<SwapView['status'], string> = {
  open: 'Open',
  accepted: 'Waiting for approval',
  approved: 'Approved',
  declined: 'Declined',
  cancelled: 'Cancelled',
};

type Report = (error: unknown) => void;

function Board({ me }: { me: Me }) {
  const dispatch = useDispatch();
  const [logout] = useLogoutMutation();
  const [filter, setFilter] = useState<Filter>('all');
  const [notice, setNotice] = useState('');
  const report: Report = (error) => setNotice(reason(error));
  const signOut = () => {
    void logout()
      .unwrap()
      .catch(() => undefined)
      .then(() => dispatch(api.util.resetApiState()));
  };

  return (
    <div className="page">
      <header>
        <h1>Shift swaps</h1>
        <span className="who">
          {me.name}
          {me.role === 'manager' ? ', manager' : ''}
        </span>
        <button onClick={signOut}>Sign out</button>
      </header>
      <p className="notice" role="alert" data-empty={notice === ''}>
        {notice}
      </p>
      <main className={me.role === 'manager' ? 'columns single' : 'columns'}>
        {me.role === 'staff' && (
          <MyShifts timeZone={me.timeZone} report={report} clear={() => setNotice('')} />
        )}
        <section aria-labelledby="swaps-title">
          <h2 id="swaps-title">Swaps</h2>
          <div className="filters" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.value} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
                {f.label}
              </button>
            ))}
          </div>
          <SwapList me={me} filter={filter} report={report} clear={() => setNotice('')} />
        </section>
      </main>
    </div>
  );
}

function MyShifts({ timeZone, report, clear }: { timeZone: string; report: Report; clear: () => void }) {
  const shifts = useMyShiftsQuery();
  return (
    <section aria-labelledby="mine-title">
      <h2 id="mine-title">My shifts</h2>
      {shifts.data?.length === 0 && <p className="empty">You have no upcoming shifts.</p>}
      <ul className="list">
        {shifts.data?.map((s) => (
          <ShiftRow key={s.id} shift={s} timeZone={timeZone} report={report} clear={clear} />
        ))}
      </ul>
    </section>
  );
}

function ShiftRow({
  shift,
  timeZone,
  report,
  clear,
}: {
  shift: MyShift;
  timeZone: string;
  report: Report;
  clear: () => void;
}) {
  const [offer, state] = useOfferMutation();
  const press = () => {
    clear();
    offer({ shiftId: shift.id }).unwrap().catch(report);
  };
  return (
    <li className="row">
      <div>
        <strong>{shift.title}</strong>
        <span className="when">{span(shift.start, shift.end, timeZone)}</span>
      </div>
      <div className="actions">
        {shift.swapId ? (
          <span className="tag">In a swap</span>
        ) : (
          <button disabled={state.isLoading} onClick={press} aria-label={`Offer ${shift.title}`}>
            Offer
          </button>
        )}
      </div>
    </li>
  );
}

function SwapList({
  me,
  filter,
  report,
  clear,
}: {
  me: Me;
  filter: Filter;
  report: Report;
  clear: () => void;
}) {
  const query = useSwapsInfiniteQuery(filter);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      {query.isSuccess && items.length === 0 && <p className="empty">Nothing here right now.</p>}
      <ul className="list">
        {items.map((s) => (
          <SwapRow key={s.id} swap={s} me={me} filter={filter} report={report} clear={clear} />
        ))}
      </ul>
      {query.hasNextPage && (
        <button
          className="more"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Show more
        </button>
      )}
    </>
  );
}

function SwapRow({
  swap,
  me,
  filter,
  report,
  clear,
}: {
  swap: SwapView;
  me: Me;
  filter: Filter;
  report: Report;
  clear: () => void;
}) {
  const [accept, accepting] = useAcceptMutation();
  const [approve, approving] = useApproveMutation();
  const [decline, declining] = useDeclineMutation();
  const [cancel, cancelling] = useCancelMutation();
  const [choosing, setChoosing] = useState(false);
  const busy = accepting.isLoading || approving.isLoading || declining.isLoading || cancelling.isLoading;
  const mine = swap.requester.id === me.id;

  const run = (action: () => { unwrap: () => Promise<unknown> }) => {
    clear();
    action().unwrap().catch(report);
  };

  return (
    <li className="row">
      <div>
        <strong>{swap.shift.title}</strong>
        <span className="when">{span(swap.shift.start, swap.shift.end, me.timeZone)}</span>
        <span className="people">
          From {swap.requester.name}
          {swap.taker ? ` to ${swap.taker.name}` : ''}
        </span>
        {swap.back && (
          <span className="people">
            In return: {swap.back.title}, {span(swap.back.start, swap.back.end, me.timeZone)}
          </span>
        )}
      </div>
      <div className="actions">
        <span className="tag" data-status={swap.status}>
          {STATUS_LABEL[swap.status]}
        </span>
        {swap.status === 'open' && !mine && me.role === 'staff' && (
          <button disabled={busy} onClick={() => setChoosing(true)}>
            Accept
          </button>
        )}
        {swap.status === 'accepted' && me.role === 'manager' && (
          <>
            <button className="primary" disabled={busy} onClick={() => run(() => approve({ id: swap.id }))}>
              Approve
            </button>
            <button disabled={busy} onClick={() => run(() => decline({ id: swap.id }))}>
              Decline
            </button>
          </>
        )}
        {(swap.status === 'open' || swap.status === 'accepted') && mine && (
          <button disabled={busy} onClick={() => run(() => cancel({ id: swap.id }))}>
            Cancel
          </button>
        )}
      </div>
      {choosing && (
        <AcceptDialog
          swap={swap}
          timeZone={me.timeZone}
          onClose={() => setChoosing(false)}
          onAccept={(backShiftId) => {
            setChoosing(false);
            run(() => accept({ id: swap.id, backShiftId, me: { id: me.id, name: me.name }, filter }));
          }}
        />
      )}
    </li>
  );
}

function AcceptDialog({
  swap,
  timeZone,
  onClose,
  onAccept,
}: {
  swap: SwapView;
  timeZone: string;
  onClose: () => void;
  onAccept: (backShiftId: string | null) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const shifts = useMyShiftsQuery();
  const [back, setBack] = useState<string | null>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const free = shifts.data?.filter((s) => !s.swapId) ?? [];

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="accept-title">
      <h2 id="accept-title">Take this shift?</h2>
      <p>
        {swap.shift.title}, {span(swap.shift.start, swap.shift.end, timeZone)}
      </p>
      <fieldset>
        <legend>In return</legend>
        <label>
          <input type="radio" name="back" checked={back === null} onChange={() => setBack(null)} />
          Nothing, I will just take it
        </label>
        {free.map((s) => (
          <label key={s.id}>
            <input type="radio" name="back" checked={back === s.id} onChange={() => setBack(s.id)} />
            {s.title}, {span(s.start, s.end, timeZone)}
          </label>
        ))}
      </fieldset>
      <div className="dialog-actions">
        <button onClick={() => ref.current?.close()}>Keep looking</button>
        <button className="primary" onClick={() => onAccept(back)}>
          Accept
        </button>
      </div>
    </dialog>
  );
}
