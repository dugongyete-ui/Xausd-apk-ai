const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Exclude .local directory from Metro's file watcher to prevent crashes
// caused by Replit's internal skill management (e.g. stale .old-* directories)
config.watchFolders = [];
config.resolver = config.resolver || {};
config.resolver.blockList = [
  /\/\.local\/.*/,
  /\/\.git\/.*/,
];

module.exports = config;
