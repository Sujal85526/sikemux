import { Redirect } from 'expo-router';

/** Where Google and GitHub hand back to the app; the sign-in itself finishes on Welcome. */
export default function SSOCallback() {
  return <Redirect href="/" />;
}
