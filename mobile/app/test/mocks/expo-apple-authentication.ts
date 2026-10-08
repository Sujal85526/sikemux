export const isAvailableAsync = async () => true;
export const signInAsync = async (_options?: { requestedScopes?: number[] }) => ({ authorizationCode: 'apple-code' as string | null });
