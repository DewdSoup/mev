/** @type {import("eslint").Linter.FlatConfig[]} */
const js = require("@eslint/js");
const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const importPlugin = require("eslint-plugin-import");
const unusedImports = require("eslint-plugin-unused-imports");
const globals = require("globals");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parser: tsParser,
      parserOptions: { project: false },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      import: importPlugin,
      "unused-imports": unusedImports,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,

      // Catch issues early
      "no-dupe-keys": "error",
      "unused-imports/no-unused-imports": "error",

      // Keep imports tidy
      "import/order": [
        "warn",
        {
          "newlines-between": "always",
          "alphabetize": { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },
  { ignores: ["dist/", "node_modules/"] },
];
