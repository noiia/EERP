// Client-safe i18n surface: the translation registry the generated manifest fills
// (build-time discovery of module `i18n/*.po` catalogs), the persisted language
// preference store, and the `useT` lookup hook. All plain data + zustand — usable
// from both barrels; nothing here touches the server.
export * from './registry'
export * from './i18n-store'
export * from './translate'
export * from './export'
export * from './T'
