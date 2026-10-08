const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

// iOS 27 refuses to launch an app built with its SDK unless a scene delegate makes the window.
// Expo ships that delegate; its template still makes the window in the app delegate.
const WINDOW =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/;

module.exports = (config) => {
  config = withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: 'EXExpoAppSceneDelegate' },
        ],
      },
    };
    return config;
  });
  return withAppDelegate(config, (config) => {
    let source = config.modResults.contents;
    if (!WINDOW.test(source)) throw new Error('scene-lifecycle: the AppDelegate template changed; its window code was not found');
    source = source
      .replace('class AppDelegate: ExpoAppDelegate {', 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {')
      .replace(WINDOW, '\n');
    config.modResults.contents = source;
    return config;
  });
};
