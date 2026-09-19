// Metro настроен так, чтобы приложение могло импортировать общее ядро из ../native-core,
// лежащее вне папки приложения (монорепо-стиль).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// следим за корнем репозитория, чтобы native-core попадал в бандл
config.watchFolders = [repoRoot];
// резолвим модули и из app/node_modules, и из корневых (на случай общих зависимостей)
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(repoRoot, 'node_modules'),
];

module.exports = config;
