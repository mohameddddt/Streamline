/**
 * Entry point for the browser build. Installs the web `window.api`, then boots
 * the exact same React app the desktop window runs.
 */
import './install'
import '../renderer/src/main'
