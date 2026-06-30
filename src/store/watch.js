// Shared "the source may have changed" watcher (window-focus / tab-visible). FSA can't
// truly watch files, so these events stand in for "might have changed". Wired once and kept
// pointing at the active store's callback, so switching backends (e.g. → WebDAV, where the
// OTHER device just edited the same files) keeps the cross-device refresh working.
let _onExternalChange = null, _watchInstalled = false;
export function installWatch(cb){
  _onExternalChange = cb;
  if (_watchInstalled) return; _watchInstalled = true;
  const fire = () => _onExternalChange && _onExternalChange();
  window.addEventListener('focus', fire);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fire(); });
}
