import Constants from 'expo-constants';

/**
 * Clerk's publishable key is public: it names the instance accounts live in. Development builds use
 * Clerk's development instance, which the accounts server on the Mac trusts.
 */
export const CLERK_PUBLISHABLE_KEY = __DEV__
  ? 'pk_test_aW1tZW5zZS1sbGFtYS02NjY4LmNsZXJrLmFjY291bnRzLmRldiQ'
  : 'pk_live_Y2xlcmsuc2lrZW11eC5jb20k';

/**
 * Release builds use api.sikemux.com. A development build uses the accounts server on the Mac
 * running Metro, or EXPO_PUBLIC_API_URL when it is set.
 */
export function apiUrl(): string {
  if (!__DEV__) return 'https://api.sikemux.com';
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/$/, '');
  const metro = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${metro ?? '127.0.0.1'}:4000`;
}
