/**
 * Builds are "Sikemux Dev" unless APP_VARIANT=production. The two install side by side,
 * each with its own key and paired hosts.
 */
/** Google's OAuth clients: production's in the `sikemux` Google Cloud project, dev's in `sikemux-dev`. */
const GOOGLE = {
  production: {
    web: '225181228835-furfr1rb7o5uhghb4i1rn7vd0igh2g1i.apps.googleusercontent.com',
    ios: '225181228835-c96vngbka2ub7na629h2jv0lamv89dhq.apps.googleusercontent.com',
  },
  dev: {
    web: '479341813252-grbmpsl75qg37pflcqagq5kmejhmso7m.apps.googleusercontent.com',
    ios: '479341813252-ku6u7otuoc0lsupno0rbn2jt8i7e6q8v.apps.googleusercontent.com',
  },
};

function googleSignIn({ web, ios }) {
  return {
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: web,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: ios,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: `com.googleusercontent.apps.${ios.replace('.apps.googleusercontent.com', '')}`,
  };
}

module.exports = ({ config }) => {
  if (process.env.APP_VARIANT === 'production') {
    return { ...config, extra: { ...config.extra, ...googleSignIn(GOOGLE.production) } };
  }
  return {
    ...config,
    name: 'Sikemux Dev',
    extra: { ...config.extra, ...googleSignIn(GOOGLE.dev) },
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
