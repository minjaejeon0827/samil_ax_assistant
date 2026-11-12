import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",                       // ← 이 줄 추가: 앱이 어느 주소(하위 경로 포함)에 올라가도 열리게
  plugins: [react()],
  server: { port: 5173, host: true },
  test: { environment: "node" },
} as never);