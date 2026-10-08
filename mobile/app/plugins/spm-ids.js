const { withPodfile } = require('expo/config-plugins');

// React Native adds Clerk's Swift packages to a Pods project whose id counter starts again at zero,
// so they take ids the project already uses, its own among them, and Xcode cannot open it. The
// counter is moved past every id CocoaPods has handed out first.
const PAST_TAKEN_IDS = `
    project = installer.pods_project
    prefix = project.instance_variable_get(:@uuid_prefix)[0, 6]
    taken = project.objects_by_uuid.keys.select { |id| id.start_with?(prefix) }.map { |id| id[6, 7].to_i(16) }
    project.instance_variable_set(:@generated_uuids, Array.new((taken.max || -1) + 1))
    project.instance_variable_set(:@available_uuids, [])`;

const BEFORE_REACT_NATIVE = /( *post_install do \|installer\|)/;

module.exports = (config) =>
  withPodfile(config, (config) => {
    const podfile = config.modResults.contents;
    if (podfile.includes('@uuid_prefix')) return config;
    if (!BEFORE_REACT_NATIVE.test(podfile)) throw new Error('spm-ids: the Podfile has no post_install hook');
    config.modResults.contents = podfile.replace(BEFORE_REACT_NATIVE, `$1${PAST_TAKEN_IDS}`);
    return config;
  });
