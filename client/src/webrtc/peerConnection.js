const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
// TURN fallback provider is not yet decided (see ARCHITECTURE.md, Phase 3).
// Add a { urls, username, credential } entry to ICE_SERVERS once chosen.

export function createPeerConnection({ onIceCandidate, onDataChannel, onConnectionStateChange }) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (event) => {
    if (event.candidate) onIceCandidate(event.candidate);
  };

  pc.ondatachannel = (event) => {
    if (onDataChannel) onDataChannel(event.channel);
  };

  pc.onconnectionstatechange = () => {
    if (onConnectionStateChange) onConnectionStateChange(pc.connectionState);
  };

  return pc;
}

export async function createOffer(pc) {
  const offer = await pc.createOffer();
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
