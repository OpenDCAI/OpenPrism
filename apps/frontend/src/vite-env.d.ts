/// <reference types="vite/client" />

declare module '*?url' {
  const src: string;
  export default src;
}

// Injected by vite.config.ts from apps/api/VERSION.
declare const __APP_VERSION__: string;
