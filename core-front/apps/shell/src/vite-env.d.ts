/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin, e.g. http://localhost:8080. Required. */
  readonly VITE_API_BASE: string
  /** API major version; defaults to "1" when unset. */
  readonly VITE_API_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
