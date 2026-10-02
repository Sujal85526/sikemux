/**
 * Builds are "Sikemux Dev" unless APP_VARIANT=production. The two install side by side,
 * each with its own key and paired hosts.
 */
/** The dev build's Google OAuth clients, in the `sikemux-dev` Google Cloud project. */
const GOOGLE_DEV_WEB_CLIENT = '479341813252-grbmpsl75qg37pflcqagq5kmejhmso7m.apps.googleusercontent.com';
const GOOGLE_DEV_IOS_CLIENT = '479341813252-ku6u7otuoc0lsupno0rbn2jt8i7e6q8v.apps.googleusercontent.com';

module.exports = ({ config }) => {
  if (process.env.APP_VARIANT === 'production') return config;
  return {
    ...config,
    name: 'Sikemux Dev',
    extra: {
      ...config.extra,
      EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: GOOGLE_DEV_WEB_CLIENT,
      EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: GOOGLE_DEV_IOS_CLIENT,
      EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: `com.googleusercontent.apps.${GOOGLE_DEV_IOS_CLIENT.replace('.apps.googleusercontent.com', '')}`,
    },
    scheme: 'sikemux-dev',
    ios: {
      ...config.ios,
      bundleIdentifier: `${config.ios.bundleIdentifier}.dev`,
      icon: './assets/dev.icon',
    },
    android: {
      ...config.android,
      package: `${config.android.package}.dev`,
      adaptiveIcon: {
        ...config.android.adaptiveIcon,
        backgroundColor: '#140c2a',
        backgroundImage: './assets/images/android-icon-background-dev.png',
      },
    },
  };
};
