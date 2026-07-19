// Pixi's browser adapter reads navigator.userAgent as soon as it is imported.
// Node 21+ provides navigator globally, but the Node 20 CI runtime does not.
// Keep the pure-logic tests in the Node environment and supply only the API
// needed during Pixi module initialization on older supported Node versions.
if (typeof globalThis.navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "node" },
  });
}
