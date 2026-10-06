const fs = require('fs');
const path = require('path');
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

// The phone's own key never leaves it, so a restored phone starts unpaired. Only shared preferences
// are backed up, and of those neither SecureStore nor the notification keys, which are wrapped by a
// Keystore key that is not restored either. Files, like the list of paired devices, never are.
const BACKUP_RULES = 'sikemux_backup_rules';
const EXTRACTION_RULES = 'sikemux_data_extraction_rules';

const RULES = `    <include domain="sharedpref" path="." />
    <exclude domain="sharedpref" path="SecureStore.xml" />
    <exclude domain="sharedpref" path="sikemux-notify.xml" />`;

const BACKUP = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
${RULES.replace(/^ {2}/gm, '')}
</full-backup-content>
`;

const EXTRACTION = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
${RULES}
  </cloud-backup>
  <device-transfer>
${RULES}
  </device-transfer>
</data-extraction-rules>
`;

module.exports = (config) => {
  config = withDangerousMod(config, [
    'android',
    (config) => {
      const xml = path.join(config.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      fs.mkdirSync(xml, { recursive: true });
      fs.writeFileSync(path.join(xml, `${BACKUP_RULES}.xml`), BACKUP);
      fs.writeFileSync(path.join(xml, `${EXTRACTION_RULES}.xml`), EXTRACTION);
      return config;
    },
  ]);
  return withAndroidManifest(config, (config) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    application.$['android:fullBackupContent'] = `@xml/${BACKUP_RULES}`;
    application.$['android:dataExtractionRules'] = `@xml/${EXTRACTION_RULES}`;
    return config;
  });
};
