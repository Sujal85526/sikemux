import { useEffect } from 'react';

import { goHome } from '@/ui/navigate';

/** Where Google and GitHub hand back to the app; the sign-in itself finishes on Welcome. */
export default function SSOCallback() {
  useEffect(goHome, []);
  return null;
}
