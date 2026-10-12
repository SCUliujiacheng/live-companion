// Electron routes getMediaSourceId permission requests through the captured
// WebContents session. An empty mediaTypes list identifies tab capture here;
// microphone/camera requests carry nonempty mediaTypes and are never granted.
// The 10 second, single-use grant is additionally bound to both live documents.
export function createCapturePermissionGate({ trustedURL, now = Date.now }) {
  const origin = new URL(trustedURL);
  origin.pathname = '/';
  origin.search = '';
  origin.hash = '';
  let pending = null;
  return {
    grant(source, receiver) {
      pending = null;
      if (!source || !receiver || source === receiver || source.isDestroyed() || receiver.isDestroyed() || receiver.getURL() !== trustedURL) {
        throw new Error('Capture documents are unavailable');
      }
      pending = {
        source, receiver, sourceFrame: source.mainFrame, receiverFrame: receiver.mainFrame,
        sourceURL: source.getURL(), expiresAt: now() + 10_000,
      };
      return pending;
    },
    revoke(grant) {
      if (!grant || pending === grant) pending = null;
    },
    request(contents, permission, details = {}) {
      const grant = pending;
      if (!grant || now() >= grant.expiresAt || contents !== grant.source || permission !== 'media'
        || grant.source.isDestroyed() || grant.receiver.isDestroyed()
        || grant.source.mainFrame !== grant.sourceFrame || grant.receiver.mainFrame !== grant.receiverFrame
        || grant.source.getURL() !== grant.sourceURL || grant.receiver.getURL() !== trustedURL
        || details.isMainFrame !== true || details.requestingUrl !== grant.sourceURL
        || !Array.isArray(details.mediaTypes) || details.mediaTypes.length !== 0) return false;
      try {
        if (new URL(details.securityOrigin).href !== origin.href) return false;
      } catch { return false; }
      pending = null;
      return true;
    },
  };
}
