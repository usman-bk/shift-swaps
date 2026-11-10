import { createApi, fetchBaseQuery, type BaseQueryFn } from '@reduxjs/toolkit/query/react';
import type { FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query';

export type Filter = 'all' | 'open' | 'accepted' | 'closed';
export type Me = { id: string; name: string; role: 'staff' | 'manager'; timeZone: string };
export type ShiftView = { id: string; title: string; start: string; end: string };
export type MyShift = ShiftView & { swapId: string | null };
export type Person = { id: string; name: string };
export type SwapView = {
  id: string;
  status: 'open' | 'accepted' | 'approved' | 'declined' | 'cancelled';
  requester: Person;
  taker: Person | null;
  shift: ShiftView;
  back: ShiftView | null;
};
export type SwapPage = { items: SwapView[]; next: string | null };

const raw = fetchBaseQuery({ baseUrl: `${window.location.origin}/api` });

// A session that runs out mid-task sends the person back to the sign-in screen
// rather than leaving buttons that fail one at a time.
const baseQuery: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (args, ctx, extra) => {
  const result = await raw(args, ctx, extra);
  if (result.error?.status === 401 && ctx.endpoint !== 'me' && ctx.endpoint !== 'login') {
    ctx.dispatch(api.util.invalidateTags(['Me']));
  }
  return result;
};

type SwapAction = { id: string };

export const api = createApi({
  baseQuery,
  tagTypes: ['Me', 'Shifts', 'Swaps'],
  endpoints: (b) => ({
    me: b.query<Me, void>({ query: () => '/me', providesTags: ['Me'] }),
    login: b.mutation<void, { email: string; password: string }>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body }),
      invalidatesTags: (_r, error) => (error ? [] : ['Me']),
    }),
    logout: b.mutation<void, void>({ query: () => ({ url: '/auth/logout', method: 'POST' }) }),
    myShifts: b.query<MyShift[], void>({ query: () => '/shifts/mine', providesTags: ['Shifts'] }),
    swaps: b.infiniteQuery<SwapPage, Filter, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (last) => last.next,
      },
      query: ({ queryArg, pageParam }) => ({
        url: '/swaps',
        params: { filter: queryArg, ...(pageParam ? { cursor: pageParam } : {}) },
      }),
      providesTags: ['Swaps'],
    }),
    offer: b.mutation<SwapView, { shiftId: string }>({
      query: (body) => ({ url: '/swaps', method: 'POST', body }),
      invalidatesTags: ['Swaps', 'Shifts'],
    }),
    accept: b.mutation<SwapView, SwapAction & { backShiftId: string | null; me: Person; filter: Filter }>({
      query: ({ id, backShiftId }) => ({
        url: `/swaps/${id}/accept`,
        method: 'POST',
        body: { backShiftId },
      }),
      // Shown as accepted at once and put back if the server says someone got
      // there first. Refetched either way, so the row ends up telling the truth.
      async onQueryStarted({ id, me, filter }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          api.util.updateQueryData('swaps', filter, (draft) => {
            for (const page of draft.pages) {
              const row = page.items.find((s) => s.id === id);
              if (row) {
                row.status = 'accepted';
                row.taker = me;
              }
            }
          }),
        );
        await queryFulfilled.catch(() => patch.undo());
      },
      invalidatesTags: ['Swaps', 'Shifts'],
    }),
    approve: b.mutation<SwapView, SwapAction>({
      query: ({ id }) => ({ url: `/swaps/${id}/approve`, method: 'POST' }),
      invalidatesTags: ['Swaps', 'Shifts'],
    }),
    decline: b.mutation<SwapView, SwapAction>({
      query: ({ id }) => ({ url: `/swaps/${id}/decline`, method: 'POST' }),
      invalidatesTags: ['Swaps', 'Shifts'],
    }),
    cancel: b.mutation<SwapView, SwapAction>({
      query: ({ id }) => ({ url: `/swaps/${id}/cancel`, method: 'POST' }),
      invalidatesTags: ['Swaps', 'Shifts'],
    }),
  }),
});

export function reason(error: unknown): string {
  const data = (error as { data?: { message?: unknown } }).data;
  return typeof data?.message === 'string' ? data.message : 'Could not reach the server. Try again.';
}
