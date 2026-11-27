/**
 * Entry point for the desktop window. Installs the Tauri-backed `window.api`,
 * then boots the same React app the web version runs.
 */
import './install'
import '../renderer/src/main'
import { showWindowWhenPainted } from './api'

showWindowWhenPainted()
