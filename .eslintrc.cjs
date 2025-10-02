module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  globals: {
    IntersectionObserver: 'readonly'
  },
  ignorePatterns: ['node_modules/'],
  rules: {
    'no-console': ['warn', { allow: ['warn', 'error'] }]
  }
};
