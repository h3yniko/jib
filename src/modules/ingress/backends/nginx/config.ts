import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_INGRESS_MAX_BODY_SIZE } from '@jib/config'
import type { Config } from '@jib/config'
import { InternalError, type JibError } from '@jib/errors'
import type { Paths } from '@jib/paths'
import { type ExecFn, ingressGetExec } from '../../exec.ts'

const GLOBAL_CONF_FILENAME = '00-jib-ingress.conf'
const NGINX_BIN = '/usr/sbin/nginx'

/** Writes the nginx global ingress settings snippet during installation. */
export async function ingressWriteNginxGlobalConfig(
  nginxDir: string,
  config: Config,
): Promise<InternalError | undefined> {
  try {
    await mkdir(nginxDir, { recursive: true, mode: 0o755 })
    await writeFile(join(nginxDir, GLOBAL_CONF_FILENAME), globalConfigBody(config), { mode: 0o644 })
  } catch (error) {
    return new InternalError('write nginx ingress config failed', { cause: error })
  }
}

/** Repairs global config drift, validates and reloads nginx, and restores files on failure. */
export async function ingressApplyNginxConfig(
  paths: Paths,
  config: Config,
  exec: ExecFn = ingressGetExec(),
): Promise<JibError | undefined> {
  const path = join(paths.nginxDir, GLOBAL_CONF_FILENAME)
  const desired = globalConfigBody(config)
  let previous: string | undefined
  const temporary = `${path}.${process.pid}.tmp`
  try {
    try {
      previous = await readFile(path, 'utf8')
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        return new InternalError('read nginx global configuration failed', { cause: error })
      }
    }
    if (previous === desired) {
      return undefined
    }
    await mkdir(paths.nginxDir, { recursive: true, mode: 0o755 })
    await writeFile(temporary, desired, { mode: 0o644 })
    await rename(temporary, path)
    const error = await reloadNginx(exec)
    if (error) {
      try {
        if (previous === undefined) {
          await rm(path, { force: true })
        } else {
          await writeFile(temporary, previous, { mode: 0o644 })
          await rename(temporary, path)
        }
      } catch (restoreError) {
        return new InternalError(
          `${error.message}; failed to restore global ingress configuration`,
          {
            cause: { error, restoreError },
          },
        )
      }
      return error
    }
  } catch (error) {
    return new InternalError('apply nginx global configuration failed', { cause: error })
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Defines the global artifact shared by installation and reconciliation. */
function globalConfigBody(config: Config): string {
  return `# Managed by jib (src/modules/ingress/backends/nginx) — do not edit.
client_max_body_size ${config.ingress?.max_body_size ?? DEFAULT_INGRESS_MAX_BODY_SIZE};
`
}

async function reloadNginx(exec: ExecFn): Promise<InternalError | undefined> {
  const test = await exec(['sudo', NGINX_BIN, '-t'])
  if (!test.ok) {
    return new InternalError(`nginx -t failed: ${test.stderr.trim()}`)
  }
  const reload = await exec(['sudo', 'systemctl', 'reload', 'nginx'])
  if (!reload.ok) {
    return new InternalError(`systemctl reload nginx failed: ${reload.stderr.trim()}`)
  }
}
