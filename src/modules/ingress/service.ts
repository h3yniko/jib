import type { App } from '@jib/config'
import { type JibError, ValidationError } from '@jib/errors'
import type { IngressClaim, IngressOperator, IngressProgress } from './types.ts'

/** Builds the ingress claim for one app, or returns a typed port error. */
export function ingressBuildClaim(app: string, appCfg: App): IngressClaim | ValidationError | null {
  if (appCfg.domains.length === 0) {
    return null
  }
  const domains: IngressClaim['domains'] = []
  for (const domain of appCfg.domains) {
    const port = getIngressPort(app, domain.host, domain.port)
    if (port instanceof Error) {
      return port
    }
    domains.push({
      host: domain.host,
      port,
      isTunnel: domain.ingress === 'cloudflare-tunnel',
    })
  }
  return { app, domains }
}

/** Applies the ingress claim through the active operator. */
export async function ingressClaim(
  operator: IngressOperator,
  app: string,
  appCfg: App,
  onProgress?: (progress: IngressProgress) => void,
): Promise<JibError | undefined> {
  const claim = ingressBuildClaim(app, appCfg)
  if (!claim) {
    return await operator.release(app, onProgress)
  }
  if (claim instanceof Error) {
    return claim
  }
  return await operator.claim(claim, onProgress)
}

/** Releases ingress state for an app through the active operator. */
export async function ingressRelease(
  operator: IngressOperator,
  app: string,
  onProgress?: (progress: IngressProgress) => void,
): Promise<JibError | undefined> {
  return await operator.release(app, onProgress)
}

/** Returns a domain port or a validation error when the resolved config is incomplete. */
function getIngressPort(
  app: string,
  host: string,
  port: number | undefined,
): number | ValidationError {
  if (port !== undefined) {
    return port
  }
  return new ValidationError(`ingress port missing for app "${app}" domain "${host}"`)
}
