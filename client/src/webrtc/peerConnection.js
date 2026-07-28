const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// TURN is read from env vars rather than hardcoded, since a real relay
// requires an account with a provider (e.g. Twilio, Xirsys, Cloudflare, or a
// self-hosted coturn) — there's no free/default TURN server to fall back to.
// Without one, peers behind symmetric NAT/strict corporate firewalls that
// STUN can't traverse will simply be unable to connect; CONNECTION_STALL_MS
// below is what surfaces that to the user instead of hanging silently.
const TURN_URL = import.meta.env.VITE_TURN_URL;
const TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME;
const TURN_CREDENTIAL = import.meta.env.VITE_TURN_CREDENTIAL;
if (TURN_URL) {
  ICE_SERVERS.push({ urls: TURN_URL, username: TURN_USERNAME, credential: TURN_CREDENTIAL });
}

export const CONNECTION_STALL_MS = 10000;
// How long iceConnectionState may sit at "disconnected" (often a transient
// blip — a brief network hiccup, a WiFi roam) before it's treated as a real
// failure worth restarting ICE over. "failed" itself restarts immediately,
// since the browser only reports that after its own internal retries are
// already exhausted — there's no point waiting further on it.
export const ICE_DISCONNECT_RESTART_MS = 5000;

export function createPeerConnection({
  onIceCandidate,
  onDataChannel,
  onConnectionStateChange,
  onStalled,
  onIceRestartNeeded,
}) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (event) => {
    if (event.candidate) onIceCandidate(event.candidate);
  };

  pc.ondatachannel = (event) => {
    if (onDataChannel) onDataChannel(event.channel);
  };

  // Detects the "stuck behind a strict NAT/firewall with no working relay"
  // failure mode: STUN-only ICE can silently never find a candidate pair, so
  // connectionState just sits at "new"/"connecting" forever with no error
  // event to hook into. A plain wall-clock timeout is the only reliable
  // signal for that — cleared/reset on every real state change.
  let stallTimer = null;
  const clearStallTimer = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };
  const armStallTimer = () => {
    clearStallTimer();
    stallTimer = setTimeout(() => {
      if (pc.connectionState === "new" || pc.connectionState === "connecting") {
        if (onStalled) onStalled(TURN_URL ? "no-route" : "no-turn-configured");
      }
    }, CONNECTION_STALL_MS);
  };
  armStallTimer();

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connecting" || pc.connectionState === "new") {
      armStallTimer();
    } else {
      clearStallTimer();
    }
    if (onConnectionStateChange) onConnectionStateChange(pc.connectionState);
  };

  // ICE-level restart. connectionState above is a coarser combination of ICE
  // + DTLS state; iceConnectionState reacts specifically to ICE trouble,
  // e.g. a mid-call network change breaking the current candidate pair.
  // "disconnected" gets a grace period since it's frequently transient (a
  // missed STUN keepalive, a brief WiFi handoff) — restarting ICE on every
  // one of those would be wasteful churn; "failed" means the browser has
  // already given up on the current candidates, so that restarts at once.
  let disconnectTimer = null;
  const clearDisconnectTimer = () => {
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
  };
  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    if (state === "failed") {
      clearDisconnectTimer();
      if (onIceRestartNeeded) onIceRestartNeeded("failed");
    } else if (state === "disconnected") {
      clearDisconnectTimer();
      disconnectTimer = setTimeout(() => {
        if (pc.iceConnectionState === "disconnected" && onIceRestartNeeded) {
          onIceRestartNeeded("disconnected-timeout");
        }
      }, ICE_DISCONNECT_RESTART_MS);
    } else {
      clearDisconnectTimer();
    }
  };

  return pc;
}

export async function createOffer(pc, options) {
  const offer = await pc.createOffer(options);
  await pc.setLocalDescription(offer);
  return offer;
}

export async function createAnswer(pc, remoteOffer) {
  await pc.setRemoteDescription(remoteOffer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return answer;
}

export async function acceptAnswer(pc, remoteAnswer) {
  await pc.setRemoteDescription(remoteAnswer);
}

export async function addIceCandidate(pc, candidate) {
  await pc.addIceCandidate(candidate);
}

// True on every browser that ships restartIce() (Chrome 113+, Firefox 117+,
// Safari 16.4+). Older engines need the legacy createOffer({ iceRestart:
// true }) path instead — checked once here so callers don't have to
// feature-detect inline.
export function supportsRestartIce(pc) {
  return typeof pc.restartIce === "function";
}
