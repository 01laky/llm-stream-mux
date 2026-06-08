import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		maxWorkers: 2,
		minWorkers: 2,
		coverage: {
			include: ["src/**"],
			reporter: ["text", "html"],
		},
	},
});
