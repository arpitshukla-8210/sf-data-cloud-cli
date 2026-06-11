/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
module.exports = {
  extends: ['eslint-config-salesforce-typescript', 'eslint-config-salesforce-license', 'plugin:sf-plugin/recommended'],
  root: true,
  rules: {
    // Allow intentionally-unused, underscore-prefixed params (e.g. the deploy mock's _request,
    // which documents the real-API payload seam without consuming it yet). Standard sf/oclif convention.
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
};
