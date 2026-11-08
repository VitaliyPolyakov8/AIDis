declare module '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js' {
  /** Emscripten factory; instantiates the embedded RNNoise WebAssembly synchronously. */
  const createRNNWasmModuleSync: () => unknown;
  export default createRNNWasmModuleSync;
}
