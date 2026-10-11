// Vite resolves `?url` imports to the URL it serves the file at.
declare module '*.wasm?url' {
  const url: string;
  export default url;
}
