import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typescriptFiles = ["**/*.ts"];
const forTypeScript = (config) => ({ ...config, files: typescriptFiles });

export default tseslint.config(
  { ignores: ["coverage/**", "dist/**", "docs/**"] },
  {
    ...eslint.configs.recommended,
    languageOptions: { globals: globals.node },
  },
  ...tseslint.configs.strictTypeChecked.map(forTypeScript),
  ...tseslint.configs.stylisticTypeChecked.map(forTypeScript),
  {
    files: typescriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
      "@typescript-eslint/no-console": "off",
    },
  },
);
