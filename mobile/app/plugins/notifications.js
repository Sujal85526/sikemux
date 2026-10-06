const fs = require('node:fs');
const path = require('node:path');
const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins');
const { withNotificationsAndroid } = require('expo-notifications/plugin/build/withNotificationsAndroid');

const SCHEME_META = 'com.nodelike.sikemux.scheme';
const EXTENSION = 'SikemuxNotifications';
const SOURCES = path.join(__dirname, '..', 'modules', 'notify', 'ios');
const EXTENSION_SOURCES = ['Extension/NotificationService.swift', 'Shared/Envelope.swift', 'Shared/Card.swift', 'Shared/Keys.swift'];

function escape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plistValue(value, indent) {
  const inner = `${indent}  `;
  if (Array.isArray(value)) return `<array>\n${value.map((item) => `${inner}${plistValue(item, inner)}\n`).join('')}${indent}</array>`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => `${inner}<key>${escape(key)}</key>\n${inner}${plistValue(item, inner)}\n`);
    return `<dict>\n${entries.join('')}${indent}</dict>`;
  }
  return `<string>${escape(String(value))}</string>`;
}

function plist(value) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistValue(value, '')}
</plist>
`;
}

/** The Keychain group the app keeps hosts' notification keys in, so its notification extension can read them. */
function keychainGroup(config) {
  return `$(AppIdentifierPrefix)${config.ios.bundleIdentifier}.notify`;
}

function extensionBundleId(config) {
  return `${config.ios.bundleIdentifier}.notifications`;
}

// Cards from hosts are built on the phone: by modules/notify on Android, which opens their links with this build's
// own scheme, and on iOS by a notification service extension that opens what the push carries.
// aps-environment stays development here; Xcode makes it production when it exports for TestFlight or the App Store.
const withNotificationsIos = (config) => {
  config = withEntitlementsPlist(config, (config) => {
    config.modResults['aps-environment'] = 'development';
    config.modResults['keychain-access-groups'] = [keychainGroup(config)];
    return config;
  });
  config = withInfoPlist(config, (config) => {
    config.modResults.SikemuxKeychainGroup = keychainGroup(config);
    const modes = new Set(config.modResults.UIBackgroundModes ?? []);
    modes.add('remote-notification');
    config.modResults.UIBackgroundModes = [...modes];
    return config;
  });
  config = withDangerousMod(config, [
    'ios',
    (config) => {
      const folder = path.join(config.modRequest.platformProjectRoot, EXTENSION);
      fs.mkdirSync(folder, { recursive: true });
      for (const source of EXTENSION_SOURCES) fs.copyFileSync(path.join(SOURCES, source), path.join(folder, path.basename(source)));
      fs.writeFileSync(
        path.join(folder, `${EXTENSION}-Info.plist`),
        plist({
          CFBundleDevelopmentRegion: '$(DEVELOPMENT_LANGUAGE)',
          CFBundleDisplayName: EXTENSION,
          CFBundleExecutable: '$(EXECUTABLE_NAME)',
          CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
          CFBundleInfoDictionaryVersion: '6.0',
          CFBundleName: '$(PRODUCT_NAME)',
          CFBundlePackageType: '$(PRODUCT_BUNDLE_PACKAGE_TYPE)',
          CFBundleShortVersionString: config.version,
          CFBundleVersion: config.ios.buildNumber ?? '1',
          SikemuxKeychainGroup: keychainGroup(config),
          NSExtension: {
            NSExtensionPointIdentifier: 'com.apple.usernotifications.service',
            NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).NotificationService',
          },
        }),
      );
      fs.writeFileSync(path.join(folder, `${EXTENSION}.entitlements`), plist({ 'keychain-access-groups': [keychainGroup(config)] }));
      return config;
    },
  ]);
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    if (project.pbxTargetByName(EXTENSION)) return config;
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};

    const appSettings = Object.values(project.pbxXCBuildConfigurationSection()).find(
      (entry) => entry.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER && entry.buildSettings.IPHONEOS_DEPLOYMENT_TARGET,
    )?.buildSettings;
    const target = project.addTarget(EXTENSION, 'app_extension', EXTENSION, extensionBundleId(config));
    const files = EXTENSION_SOURCES.map((source) => path.basename(source));
    const group = project.addPbxGroup([...files, `${EXTENSION}-Info.plist`, `${EXTENSION}.entitlements`], EXTENSION, EXTENSION);
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    project.addBuildPhase(files, 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);

    for (const entry of Object.values(project.pbxXCBuildConfigurationSection())) {
      if (entry.buildSettings?.PRODUCT_NAME !== `"${EXTENSION}"`) continue;
      Object.assign(entry.buildSettings, {
        CODE_SIGN_ENTITLEMENTS: `${EXTENSION}/${EXTENSION}.entitlements`,
        CODE_SIGN_STYLE: 'Automatic',
        IPHONEOS_DEPLOYMENT_TARGET: appSettings?.IPHONEOS_DEPLOYMENT_TARGET ?? '17.0',
        SWIFT_VERSION: '5.0',
        TARGETED_DEVICE_FAMILY: '1',
        ...(config.ios.appleTeamId ? { DEVELOPMENT_TEAM: config.ios.appleTeamId } : {}),
      });
    }
    if (config.ios.appleTeamId) project.addTargetAttribute('DevelopmentTeam', config.ios.appleTeamId, target);
    return config;
  });
};

module.exports = (config) => {
  config = withNotificationsAndroid(config, { icon: '../../brand/mark/mark-white-256.png', color: '#a277ff' });
  config = withAndroidManifest(config, (config) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    const scheme = Array.isArray(config.scheme) ? config.scheme[0] : config.scheme;
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, SCHEME_META, scheme);
    return config;
  });
  return withNotificationsIos(config);
};
