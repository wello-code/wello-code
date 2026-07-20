import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/out-tsc/**",
      "**/build/**",
      "**/.vite/**",
      "**/coverage/**",
      "promt/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Plain JS/Node scripts and tool configs run in Node — give them Node globals.
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Node scripts that drive a browser: the bodies passed to page.evaluate() are
    // serialised and run in the page, so they legitimately reference document and
    // friends even though the file itself is Node.
    files: ["apps/desktop/scripts/mac-shot.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
