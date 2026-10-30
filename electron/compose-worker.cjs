const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
try {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  // Only JSON text enters the context; no host object/function references enter.
  const code = workerData.script + '\n;if(typeof main!=="function")throw Error("main required");JSON.stringify(main(JSON.parse(' + JSON.stringify(workerData.input) + ')));';
  const result = new vm.Script(code).runInContext(context, { timeout: 100 });
  if (typeof result !== 'string' || Buffer.byteLength(result) > 8 * 1024 * 1024) throw Error('invalid output');
  parentPort.postMessage({ result });
} catch { parentPort.postMessage({ error: true }); }
