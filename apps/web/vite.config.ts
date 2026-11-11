import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const serverPort = process.env.ORGANIZER_PORT ?? "4802";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5181,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${serverPort}`,
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
  },
});
