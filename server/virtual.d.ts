declare module 'virtual:assets' {
  /** Base64 content of every file in dist/, keyed by its path relative to dist/. */
  export const assets: Record<string, string>;
}
