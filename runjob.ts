import { promises as fs } from 'fs';
import path from 'path';
// Import the standard Node.js argument parser utility.
import { parseArgs as parse } from 'node:util';

// --- Type Definitions for clarity ---
interface CliOptions {
	configPath: string;
	quiet: boolean;
}

interface JobConfig {
	targetUrl: string;
	// other config properties...
}

// Replaced the brittle, manual parser with Node.js's standard `util.parseArgs`.
// This new version correctly handles different argument formats (e.g., --config=file.json)
// and is much more robust.
function parseCliArgs(argv: string[]): CliOptions {
	try {
		const { values } = parse({
			args: argv.slice(2),
			options: {
				config: { type: 'string', short: 'c' },
				quiet: { type: 'boolean', short: 'q' },
				help: { type: 'boolean', short: 'h' },
			},
		});

		if (values.help) {
			printHelp();
			process.exit(0);
		}

		if (!values.config) {
			throw new Error('Configuration file not specified. Use --config <path> or -c <path>.');
		}

		return {
			configPath: values.config,
			quiet: values.quiet || false,
		};
	} catch (err: any) {
		// Provide a more user-friendly error message for unknown arguments.
		console.error(`Error: ${err.message}\n`);
		printHelp();
		process.exit(1);
	}
}

function printHelp(): void {
	console.log(`OmniForm Phantom ? Headless Runner

Usage:
  node <script> --config <file> [options]

Options:
  -c, --config <file>    Path to job configuration JSON file (required)
  -q, --quiet            Suppress non-error log output
  -h, --help             Show this help and exit
`);
}

async function loadConfig(filePath: string): Promise<JobConfig> {
	const resolved = path.resolve(process.cwd(), filePath);

	try {
		const raw = await fs.readFile(resolved, 'utf8');
		// Add structural validation for a more robust config loading
		const config = JSON.parse(raw);
		if (!config || typeof config.targetUrl !== 'string') {
			throw new Error('Configuration file is missing required "targetUrl" property.');
		}
		return config as JobConfig;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`Configuration file not found: ${resolved}`);
		}
		if (error instanceof SyntaxError) {
			throw new Error(`Configuration file is not valid JSON: ${resolved}`);
		}
		// Re-throw other errors, including our validation error
		throw error;
	}
}

/* -------------------------------------------------------------------------- */
/* Core Job Logic (placeholder)                                               */
/* -------------------------------------------------------------------------- */

async function runHeadlessJob(config: JobConfig, quiet = false): Promise<void> {
	if (!quiet) {
		console.log(`-> Starting headless job for ${config.targetUrl}`);
	}

	// Simulate async work...
	await new Promise((resolve) => setTimeout(resolve, 1000));

	if (!quiet) {
		console.log('-> Job completed successfully.');
	}
}

/* -------------------------------------------------------------------------- */
/* Main Entrypoint                                                            */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
	try {
		// The main logic is now cleaner, relying on the robust parser.
		const options = parseCliArgs(process.argv);
		const config = await loadConfig(options.configPath);
		await runHeadlessJob(config, options.quiet);
		process.exitCode = 0;
	} catch (error: unknown) {
		// The main error handler is now simpler.
		// Specific parsing errors are handled inside `parseCliArgs`.
		if (error instanceof Error) {
			console.error(`\nError: ${error.message}`);
		} else {
			console.error(`\nAn unknown error occurred:`, error);
		}
		process.exitCode = 1;
	}
}

// Start the application
void main();