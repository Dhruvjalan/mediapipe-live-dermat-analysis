// Lets `node --test` load the app's TypeScript sources, which use extensionless
// imports (Vite style). Node strips the types itself; this only adds ".ts".
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
      if (err?.code === 'ERR_MODULE_NOT_FOUND' && isRelative && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }
  },
});
