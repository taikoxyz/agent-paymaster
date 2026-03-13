import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "packages/paymaster-contracts/artifacts/**",
      "packages/paymaster-contracts/cache/**",
      "packages/web/next-env.d.ts",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
        },
      ],
    },
  },
  {
    name: "next/global",
    plugins: {
      "@next/next": nextPlugin,
    },
    settings: {
      next: {
        rootDir: "packages/web/",
      },
    },
  },
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    name: nextPlugin.flatConfig.recommended.name,
    settings: {
      next: {
        rootDir: "packages/web/",
      },
    },
    rules: {
      ...nextPlugin.flatConfig.recommended.rules,
    },
  },
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    name: nextPlugin.flatConfig.coreWebVitals.name,
    settings: {
      next: {
        rootDir: "packages/web/",
      },
    },
    rules: {
      ...nextPlugin.flatConfig.coreWebVitals.rules,
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
);
