'use strict';

const path = require('node:path');

const PATH_LIST_VARIABLES = [
  'LD_LIBRARY_PATH',
  'PATH',
  'GTK_PATH',
  'GIO_EXTRA_MODULES',
  'GSETTINGS_SCHEMA_DIR',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
  'QT_PLUGIN_PATH',
  'PYTHONPATH',
  'PERLLIB',
];

const APPIMAGE_VARIABLES = [
  'APPDIR',
  'APPIMAGE',
  'ARGV0',
  'OWD',
  'APPIMAGE_SILENT_INSTALL',
];

/**
 * AppImage's AppRun prepends its bundled libraries and data directories to the
 * environment. Those paths must not leak into Steam or CS2 when they are
 * launched from the app, otherwise the external programs can load the wrong
 * shared libraries.
 */
function sanitizeAppImageEnvironment(env = process.env, appDir = env.APPDIR) {
  if (!appDir || typeof appDir !== 'string') {
    return false;
  }

  const normalizedDir = appDir.replace(/[\\/]+$/, '');
  if (!normalizedDir) {
    return false;
  }
  const appDirPrefix = normalizedDir + path.sep;

  for (const name of PATH_LIST_VARIABLES) {
    const value = env[name];
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }
    const entries = value.split(path.delimiter).filter(Boolean);
    const filtered = entries.filter((entry) => (
      entry !== normalizedDir && !entry.startsWith(appDirPrefix)
    ));
    if (filtered.length === entries.length) {
      continue;
    }
    if (filtered.length > 0) {
      env[name] = filtered.join(path.delimiter);
    } else {
      delete env[name];
    }
  }

  for (const name of APPIMAGE_VARIABLES) {
    delete env[name];
  }

  return true;
}

module.exports = {sanitizeAppImageEnvironment};
