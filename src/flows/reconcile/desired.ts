import { createHash } from 'node:crypto'
import type { App, Config } from '@jib/config'
import { ValidationError } from '@jib/errors'
import { ingressBuildClaim } from '@jib/ingress'

/** Constructs comparable desired state without persisting resolved secrets. */
export function reconcileDesiredState(
  ctx: { cfg: Config },
  app: string,
  appCfg: App,
  model: Record<string, unknown>,
) {
  const claim = ingressBuildClaim(app, appCfg)
  if (claim instanceof Error) {
    return claim
  }
  const services = model.services
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    return new ValidationError('resolved Compose config must contain services')
  }
  const builds: Record<string, unknown> = {}
  for (const [name, service] of Object.entries(services)) {
    if (!service || typeof service !== 'object' || Array.isArray(service)) {
      return new ValidationError(`invalid resolved Compose service "${name}"`)
    }
    if ('build' in service && service.build) {
      builds[name] = service.build
    }
  }
  return {
    build: fingerprint(builds),
    hasBuild: Object.keys(builds).length > 0,
    runtime: fingerprint({ model, services: appCfg.services ?? [], health: appCfg.health ?? [] }),
    ingress: fingerprint({ claim, global: ctx.cfg.ingress ?? {} }),
  }
}

// Canonicalize objects recursively; preserve array order because it can affect Compose behavior.
function fingerprint(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) {
      return input.map(canonical)
    }
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonical(item)]),
      )
    }
    return input
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}
