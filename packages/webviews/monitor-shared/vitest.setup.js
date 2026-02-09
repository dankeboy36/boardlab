if (typeof globalThis.CSSStyleSheet === 'undefined') {
  // Minimal shim for lit/vscode-elements in jsdom.
  globalThis.CSSStyleSheet = class CSSStyleSheet {
    replaceSync() {}
  }
} else if (!globalThis.CSSStyleSheet.prototype.replaceSync) {
  globalThis.CSSStyleSheet.prototype.replaceSync = function replaceSync() {}
}
