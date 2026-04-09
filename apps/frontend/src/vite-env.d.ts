/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端根地址，例如 http://127.0.0.1:8787；用于静态托管前端且 API 在另一端口时 */
  readonly VITE_API_BASE?: string;
}

declare module '*?url' {
  const src: string;
  export default src;
}
