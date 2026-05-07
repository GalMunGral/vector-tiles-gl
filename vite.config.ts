import { defineConfig } from "vite";

export default defineConfig({
  define: {
    "import.meta.env.TOKEN": JSON.stringify(process.env.TOKEN),
  },
  build: {
    outDir: "dist",
  },
});