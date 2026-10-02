/** Clerk reports problems as an error with a stable `code`, sometimes inside an `errors` list. */
type Reported = {
  code?: string;
  message?: string;
  longMessage?: string;
  errors?: Reported[];
};

export function errorCode(error: unknown): string | undefined {
  const reported = error as Reported | null | undefined;
  return reported?.errors?.[0]?.code ?? reported?.code;
}

/** Words for the person: Clerk's own long message when it has one, which is written for them. */
export function explain(error: unknown): string {
  const reported = error as Reported | null | undefined;
  const first = reported?.errors?.[0] ?? reported;
  return (
    first?.longMessage ?? first?.message ?? "Something went wrong; try again."
  );
}
