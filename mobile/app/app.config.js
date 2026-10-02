/**
 * Builds are "Sikemux Dev" unless APP_VARIANT=production. The two install side by side,
 * each with its own key and paired Macs.
 */
/** Google's OAuth clients in the `sikemux` Google Cloud project. Only the dev build has its own so far. */
const GOOGLE_WEB_CLIENT = '225181228835-furfr1rb7o5uhghb4i1rn7vd0igh2g1i.apps.googleusercontent.com';
const GOOGLE_DEV_IOS_CLIENT = '225181228835-omhkn11gds8rv612qvv3qrjt47eqvnpr.apps.googleusercontent.com';

module.exports = ({ config }) => {
  if (process.env.APP_VARIANT === 'production') return config;
  return {
    ...config,
    name: 'Sikemux Dev',
    extra: {
      ...config.extra,
      EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: GOOGLE_WEB_CLIENT,
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
