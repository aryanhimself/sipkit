import type { EngineFactory } from '../../types';
import { SipJsEngine } from './engine';

export { SipJsEngine } from './engine';
export {
  buildTargetUri,
  parseAutoAnswer,
  reasonFromCode,
  resolveSipDomain,
  sdpIndicatesHold,
  parseInfoDtmf,
} from './helpers';

/** Factory for the default SIP.js (WebRTC) engine. */
export function sipjsEngine(): EngineFactory {
  return () => new SipJsEngine();
}
