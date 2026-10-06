import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { InternalError, type JibError, errorsToJibError } from '@jib/errors'
import { type ExecFn, ingressGetExec } from '../../exec.ts'
import type { IngressClaim, IngressOperator } from '../../types.ts'
import {
  ingressNginxAppConfDir,
  ingressNginxConfFilename,
  ingressRenderNginxSite,
} from './templates.ts'

export type IngressCertExistsFn = (host: string) => Promise<boolean | JibError>

const LETSENCRYPT_LIVE = '/etc/letsencrypt/live'
const NGINX_BIN = '/usr/sbin/nginx'

/** Checks whether a Let's Encrypt certificate exists for one hostname. */
const defaultCertExists: IngressCertExistsFn = async (host) => {
  try {
    await stat(`${LETSENCRYPT_LIVE}/${host}/fullchain.pem`)
    return true
  } catch (error) {
    if (isMissingPathError(error)) {
      return false
    }
    const message = error instanceof Error ? error.message : String(error)
    return new InternalError(`read certificate for ${host}: ${message}`, { cause: error })
  }
}

export interface IngressNginxDeps {
  nginxDir: string
  exec?: ExecFn
  certExists?: IngressCertExistsFn
}

/** Creates the nginx-backed ingress operator. */
export function ingressCreateNginxOperator(deps: IngressNginxDeps): IngressOperator {
  const exec = deps.exec ?? ingressGetExec()
  const certExists = deps.certExists ?? defaultCertExists

  return {
    async claim(claim, onProgress) {
      const rendered = await renderSites(claim, certExists)
      if (rendered instanceof Error) {
        return rendered
      }
      try {
        const dir = ingressNginxAppConfDir(deps.nginxDir, claim.app)
        const files = await readdir(dir)
        if (files.length === rendered.size && files.every((file) => rendered.has(file))) {
          const contents = await Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')))
          if (files.every((file, index) => rendered.get(file) === contents[index])) {
            return undefined
          }
        }
      } catch (error) {
        if (!isMissingPathError(error)) {
          return errorsToJibError(error)
        }
      }
      const staged = await stageNginxAppDir(deps.nginxDir, claim.app)
      if (staged instanceof Error) {
        return staged
      }
      try {
        onProgress?.({ app: claim.app, message: `writing ${claim.domains.length} config(s)` })
        const dir = ingressNginxAppConfDir(deps.nginxDir, claim.app)
        await mkdir(dir, { recursive: true, mode: 0o755 })
        for (const [filename, body] of rendered) {
          await writeFile(join(dir, filename), body, { mode: 0o644 })
        }
        onProgress?.({ app: claim.app, message: 'running nginx -t + reload' })
        const reloadError = await reloadNginx(exec)
        if (reloadError) {
          return await restoreAfterFailure(staged, reloadError)
        }
        return await discardStagedAppDir(staged)
      } catch (error) {
        return await restoreAfterFailure(staged, errorsToJibError(error))
      }
    },
    async release(app, onProgress) {
      const staged = await stageNginxAppDir(deps.nginxDir, app)
      if (staged instanceof Error) {
        return staged
      }
      if (!staged.existed) {
        return undefined
      }
      try {
        onProgress?.({ app, message: `removing configs for ${app}` })
        const reloadError = await reloadNginx(exec)
        if (reloadError) {
          return await restoreAfterFailure(staged, reloadError)
        }
        return await discardStagedAppDir(staged)
      } catch (error) {
        return await restoreAfterFailure(staged, errorsToJibError(error))
      }
    },
  }
}

/** Restores a staged config after failure and retains both the primary and restoration errors. */
async function restoreAfterFailure(staged: StagedAppDir, failure: JibError): Promise<JibError> {
  const restoreError = await restoreStagedAppDir(staged)
  if (!restoreError) {
    return failure
  }
  return new InternalError(
    `${failure.message}; failed to restore previous nginx config: ${restoreError.message}`,
    { cause: { failure, restoreError } },
  )
}

/** Resolves certificate state and renders the complete desired app directory. */
async function renderSites(
  claim: IngressClaim,
  certExists: IngressCertExistsFn,
): Promise<Map<string, string> | JibError> {
  try {
    const files = new Map<string, string>()
    for (const domain of claim.domains) {
      const hasSSL = domain.isTunnel ? false : await certExists(domain.host)
      if (hasSSL instanceof Error) {
        return hasSSL instanceof InternalError
          ? hasSSL
          : new InternalError(hasSSL.message, { cause: hasSSL })
      }
      const body = ingressRenderNginxSite({
        host: domain.host,
        port: domain.port,
        isTunnel: domain.isTunnel,
        hasSSL,
      })
      files.set(ingressNginxConfFilename(domain.host), body)
    }
    return files
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return new InternalError(`write nginx config for ${claim.app}: ${message}`, { cause: error })
  }
}

interface StagedAppDir {
  backup: string
  current: string
  existed: boolean
}

/** Moves the current app config directory aside so it can be restored after a failed update. */
async function stageNginxAppDir(
  nginxDir: string,
  app: string,
): Promise<StagedAppDir | InternalError> {
  const current = ingressNginxAppConfDir(nginxDir, app)
  // The nginx include matches */*.conf. Keep backups one directory deeper
  // so validation and reload see only the new desired routes.
  const stagingDir = join(nginxDir, '.staging')
  const backup = join(stagingDir, `${app}-${randomUUID()}`)
  try {
    await mkdir(stagingDir, { recursive: true, mode: 0o755 })
    await rename(current, backup)
    return { current, backup, existed: true }
  } catch (error) {
    if (isMissingPathError(error)) {
      return { current, backup, existed: false }
    }
    const message = error instanceof Error ? error.message : String(error)
    return new InternalError(`stage nginx config for ${app}: ${message}`, { cause: error })
  }
}

/** Restores a staged directory after an unsuccessful nginx configuration update. */
async function restoreStagedAppDir(staged: StagedAppDir): Promise<InternalError | undefined> {
  try {
    await rm(staged.current, { recursive: true, force: true })
    if (!staged.existed) {
      return undefined
    }
    await rename(staged.backup, staged.current)
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return new InternalError(`restore nginx config: ${message}`, { cause: error })
  }
}

/** Deletes the staged backup after nginx accepted the new configuration. */
async function discardStagedAppDir(staged: StagedAppDir): Promise<InternalError | undefined> {
  if (!staged.existed) {
    return undefined
  }
  try {
    await rm(staged.backup, { recursive: true, force: true })
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return new InternalError(`discard nginx config backup: ${message}`, { cause: error })
  }
}

/** Validates then reloads nginx through the configured command runner. */
async function reloadNginx(exec: ExecFn): Promise<InternalError | undefined> {
  const test = await exec(['sudo', NGINX_BIN, '-t'])
  if (!test.ok) {
    return new InternalError(`nginx -t failed: ${test.stderr.trim()}`)
  }
  const reload = await exec(['sudo', 'systemctl', 'reload', 'nginx'])
  if (!reload.ok) {
    return new InternalError(`systemctl reload nginx failed: ${reload.stderr.trim()}`)
  }
  return undefined
}

/** Checks whether an operating-system error represents a missing filesystem path. */
function isMissingPathError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}
