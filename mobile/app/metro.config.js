const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The chat transcript comes from the Mac app's own reducer (src/chat), so the
// phone reads an agent's updates exactly as the Mac does.
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, '../../src')];

module.exports = config;
