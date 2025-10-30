import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  
  // Clear screen for better Electron integration
  clearScreen: false,
  
  server: {
    port: 5173,
    strictPort: false,
    host: "localhost",
  },
});
