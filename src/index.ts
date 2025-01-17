import path from "node:path"
import { Plugin, ResolvedConfig } from "vite"
import MagicString from "magic-string"
import { bundleRequire } from "bundle-require"
import * as devalue from "devalue"

type MaybePromise<T> = T | Promise<T>

export type CompileTimeFunctionArgs = {
  /** Vite resolved config */
  viteConfig: ResolvedConfig
}

export type CompileTimeFunctionResult<TData = unknown> = MaybePromise<{
  /** Get data at compile time */
  data?: TData
  /** Generate code at compile time */
  code?: string
  /** Trigger rebuild when watched files change */
  watchFiles?: string[]
}>

export type CompileTimeFunction<TData = unknown> = (
  args: CompileTimeFunctionArgs,
) => CompileTimeFunctionResult<TData>

const createPlugins = (): Plugin[] => {
  let useSourceMap = false

  const loadCache: Map<
    string,
    { data?: any; code?: string; watchFiles?: string[] }
  > = new Map()

  let resolvedConfig: ResolvedConfig

  return [
    {
      name: "compile-time",
      enforce: "pre",
      configResolved(config) {
        useSourceMap = !!config.build.sourcemap
        resolvedConfig = config
      },
      configureServer(server) {
        server.watcher.on("all", (_, id) => {
          for (const [k, cache] of loadCache) {
            if (cache.watchFiles?.includes(id)) {
              loadCache.delete(k)
            }
          }
        })
      },
      async transform(code, id) {
        if (
          id.includes("node_modules") ||
          !/\.(js|ts|jsx|tsx|mjs|vue|svelte)$/.test(id)
        )
          return

        const m = [
          ...code.matchAll(
            /import\.meta\.compileTime(?:<\w+>)?\s*\(\s*['"`]?(.*?)['"`]?\s*\)/g,
          ),
        ]

        if (m.length === 0) return

        const s = new MagicString(code)
        const dir = path.dirname(id)
        for (const item of m) {
          const start = item.index!
          const end = item.index! + item[0].length
          const filepath = path.resolve(dir, item[1])

          const cacheKey = filepath
          let cache = loadCache.get(cacheKey)
          if (!cache) {
            const { mod, dependencies } = await bundleRequire({ filepath })
            const defaultExport: CompileTimeFunction | undefined =
              mod.default || mod
            cache =
              (defaultExport &&
                (await defaultExport({ viteConfig: resolvedConfig }))) ||
              {}
            cache.watchFiles = [
              filepath,
              ...(cache.watchFiles || []),
              ...dependencies.map((p) => path.resolve(p)),
            ]
            if (cache.data) {
              cache.data = devalue.uneval(cache.data)
            }
            loadCache.set(cacheKey, cache)
          }

          let replacement = "null"
          if (cache.watchFiles) {
            cache.watchFiles.forEach((filepath) => {
              this.addWatchFile(filepath)
            })
          }
          if (cache.data !== undefined) {
            replacement = cache.data
          } else if (cache.code !== undefined) {
            replacement = cache.code
          }

          s.overwrite(start, end, replacement)
        }
        return {
          code: s.toString(),
          map: useSourceMap ? s.generateMap({ source: id }) : null,
        }
      },
    },
  ]
}

export default createPlugins
