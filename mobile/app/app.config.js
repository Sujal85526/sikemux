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

/** Play needs a number that grows with every upload: 0.5.0-nightly.3 is 50003, and 0.5.0 itself is 50099. */
function androidVersionCode(version, base) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d+))?$/.exec(version);
  if (!match) throw new Error(`${version} is not a version like 0.5.0 or 0.5.0-nightly.3`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const nightly = match[4] === undefined ? null : Number(match[4]);
  if (`${major}.${minor}.${patch}` !== base) throw new Error(`${version} is not a release of ${base}, the version in app.json`);
  if (minor > 99 || patch > 99 || nightly > 98) throw new Error(`${version} does not fit the version code scheme`);
  return major * 1_000_000 + minor * 10_000 + patch * 100 + (nightly ?? 99);
}

module.exports = ({ config }) => {
  if (process.env.APP_VARIANT === 'production') {
    const version = process.env.SIKEMUX_MOBILE_VERSION ?? config.version;
    return {
      ...config,
      extra: { ...config.extra, ...googleSignIn(GOOGLE.production) },
      android: { ...config.android, versionCode: androidVersionCode(version, config.version) },
    };
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
