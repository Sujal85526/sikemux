/** How the person proves it is them again before the account goes: a code sent to their email, or their password. */
export type Factor = { strategy: 'email_code'; to: string } | { strategy: 'password' };

export type DeletionPhase =
  { name: 'confirm' } | { name: 'deleting' } | { name: 'verify'; factor: Factor; entry: string; checking: boolean } | { name: 'done' };

export type DeletionState = { expected: string; typed: string; problem?: string; phase: DeletionPhase };

export type DeletionAction =
  | { type: 'typed'; text: string }
  | { type: 'delete' }
  | { type: 'reverify'; factor: Factor }
  | { type: 'entered'; entry: string }
  | { type: 'checking' }
  | { type: 'rejected'; problem: string }
  | { type: 'verified' }
  | { type: 'cancelled' }
  | { type: 'failed'; problem: string }
  | { type: 'deleted' };

/** The text that confirms: the account's email, or the word "delete" for an account without one. */
export function startDeletion(email: string | undefined): DeletionState {
  return { expected: email ?? 'delete', typed: '', phase: { name: 'confirm' } };
}

export function confirmed(state: Pick<DeletionState, 'expected' | 'typed'>): boolean {
  return state.typed.trim().toLowerCase() === state.expected.trim().toLowerCase();
}

/** Steps through deleting: confirm by typing, delete, prove it is them again if the server asks, done. */
export function deletion(state: DeletionState, action: DeletionAction): DeletionState {
  const phase = state.phase;
  switch (action.type) {
    case 'typed':
      return phase.name === 'confirm' ? { ...state, typed: action.text, problem: undefined } : state;
    case 'delete':
      return phase.name === 'confirm' && confirmed(state) ? { ...state, problem: undefined, phase: { name: 'deleting' } } : state;
    case 'reverify':
      return phase.name === 'deleting'
        ? { ...state, problem: undefined, phase: { name: 'verify', factor: action.factor, entry: '', checking: false } }
        : state;
    case 'entered':
      return phase.name === 'verify' && !phase.checking
        ? { ...state, problem: undefined, phase: { ...phase, entry: action.entry } }
        : state;
    case 'checking':
      return phase.name === 'verify' ? { ...state, problem: undefined, phase: { ...phase, checking: true } } : state;
    case 'rejected':
      return phase.name === 'verify' ? { ...state, problem: action.problem, phase: { ...phase, entry: '', checking: false } } : state;
    case 'verified':
      return phase.name === 'verify' ? { ...state, problem: undefined, phase: { name: 'deleting' } } : state;
    case 'cancelled':
      return phase.name === 'verify' || phase.name === 'deleting' ? { ...state, problem: undefined, phase: { name: 'confirm' } } : state;
    case 'failed':
      return phase.name === 'verify' || phase.name === 'deleting'
        ? { ...state, problem: action.problem, phase: { name: 'confirm' } }
        : state;
    case 'deleted':
      return phase.name === 'deleting' ? { ...state, problem: undefined, phase: { name: 'done' } } : state;
  }
}

/**
 * What Clerk's `useReverification` looks for in a request's result before it asks the person to verify
 * and then retries: first factor, within the server's ten minutes.
 */
export const REVERIFY_HINT = {
  clerk_error: {
    type: 'forbidden',
    reason: 'reverification-error',
    metadata: { reverification: { level: 'first_factor', afterMinutes: 10 } },
  },
} as const;

/** A password is quickest for an account that has one; anyone else gets a code at their email. */
export function chooseFactor(
  supported: readonly ({ strategy: string } & { emailAddressId?: string; safeIdentifier?: string })[],
): { factor: Factor; emailAddressId?: string } | undefined {
  if (supported.some((factor) => factor.strategy === 'password')) return { factor: { strategy: 'password' } };
  const email = supported.find((factor) => factor.strategy === 'email_code' && factor.emailAddressId);
  if (email?.emailAddressId)
    return { factor: { strategy: 'email_code', to: email.safeIdentifier ?? 'your email' }, emailAddressId: email.emailAddressId };
  return undefined;
}
