import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		ignores: ["dist/**", "node_modules/**", "coverage/**", "docs/img/*.svg"],
	},
	{
		files: ["scripts/**/*.mjs", "eslint.config.js"],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "module",
			globals: {
				...globals.node,
			},
		},
	},
	{
		files: ["src/**/*.ts", "test/**/*.ts", "*.ts"],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "module",
			globals: {
				...globals.node,
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
	{
		files: ["test/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.vitest,
			},
		},
	},
);
