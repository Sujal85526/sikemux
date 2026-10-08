import { router } from 'expo-router';

/** Returns to the Devices screen already under everything, rather than stacking a second one. */
export function goHome() {
  router.dismissTo('/');
}

/** Back one screen, or home when the app was opened straight onto this one. */
export function goBack() {
  if (router.canGoBack()) router.back();
  else goHome();
}
