import eslint from "@eslint/js";

export default [
	{
		ignores: ["dist/**", "node_modules/**", "coverage/**", "docs/img/*.svg"],
	},
	{
		files: ["scripts/**/*.mjs", "eslint.config.js"],
		...eslint.configs.recommended,
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "module",
			globals: {
				console: "readonly",
				process: "readonly",
			},
		},
	},
];
