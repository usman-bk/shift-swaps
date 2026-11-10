export type Code =
  | 'bad_request'
  | 'bad_login'
  | 'not_signed_in'
  | 'managers_only'
  | 'not_found'
  | 'not_your_shift'
  | 'own_swap'
  | 'already_taken'
  | 'shift_in_another_swap'
  | 'shift_has_started'
  | 'wrong_state'
  | 'owner_changed'
  | 'would_double_book'
  | 'too_little_rest';

export class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: Code,
    message: string,
  ) {
    super(message);
  }
}
