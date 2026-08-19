import { spawn, exec, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const examples = ['vite-6', 'vite-7', 'vite-8'];
const pluginHookSsrDeprecation =
  "Plugin hook `options.ssr` is replaced with `this.environment.config.consumer === 'server'`.";
const PORT = 4173;
const TEST_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const cypressEnv = { ...process.env, ELECTRON_RUN_AS_NODE: undefined };

// Track active processes for cleanup
const activeProcesses = new Set<ChildProcess>();

// Cleanup function
function cleanup(exitCode = 0) {
  for (const proc of activeProcesses) {
    proc.kill('SIGTERM');
  }
  process.exit(exitCode);
}

// Handle termination signals
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

async function runExample(example) {
  console.log(`Testing ${example}...`);
  const examplePath = `examples/${example}`;

  try {
    // Install and build
    await execAsync('pnpm install', { cwd: examplePath });
    const { stdout, stderr } = await execAsync('pnpm run build', { cwd: examplePath });
    if (`${stdout}\n${stderr}`.includes(pluginHookSsrDeprecation)) {
      throw new Error(`Vite's deprecated plugin hook SSR argument was used in ${example}`);
    }

    // Start preview server with timeout
    const server = spawn('pnpm', ['run', 'preview'], { cwd: examplePath });
    activeProcesses.add(server);

    server.on('error', (err) => {
      console.error(`Server error for ${example}:`, err);
      throw err;
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Run Cypress tests with timeout
    const testPromise = execAsync(
      `pnpm exec cypress run --config-file cypress.config.ts --env example=${example}`,
      { env: cypressEnv },
    );
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Test timeout for ${example}`)), TEST_TIMEOUT)
    );

    await Promise.race([testPromise, timeoutPromise]);
  } finally {
    // Clean up processes
    for (const proc of activeProcesses) {
      proc.kill('SIGTERM');
      activeProcesses.delete(proc);
    }
  }
}

async function runAll() {
  for (const example of examples) {
    try {
      await runExample(example);
    } catch (error) {
      console.error(`Error testing ${example}:`, error);
      cleanup(1);
    }
  }
  process.exit(0);
}

runAll().catch(error => {
  console.error('Unexpected error:', error);
  cleanup(1);
});
