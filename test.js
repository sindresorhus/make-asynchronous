import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';
import test from 'ava';
import timeSpan from 'time-span';
import inRange from 'in-range';
import makeAsynchronous, {makeAsynchronousIterable} from './index.js';

const abortError = new Error('Aborted');
const execFileAsync = promisify(execFile);
const source = await fs.readFile(new URL('index.js', import.meta.url), 'utf8');
const package_ = JSON.parse(await fs.readFile(new URL('package.json', import.meta.url), 'utf8'));

test('browser entrypoint does not statically import worker_threads', t => {
	t.notRegex(source, /^import .*node:worker_threads/mv);
	t.notRegex(source, /import\(['"]node:worker_threads['"]\)/v);
});

test('Node engine supports syntax detection and module hooks', t => {
	t.is(package_.engines.node, '>=22.15.0');
});

test('main', async t => {
	const fixture = {x: '🦄'};
	const end = timeSpan();

	const result = await makeAsynchronous(fixture => {
		let x = '1';

		while (true) {
			x += Math.random() < 0.5 ? Date.now().toString() : '0';

			if (x >= 9_999_999_999_999) {
				break;
			}
		}

		return fixture;
	})(fixture);

	t.true(inRange(end(), {start: 10, end: 1000}), `${end()}`);
	t.deepEqual(result, fixture);
});

test('with pre-aborted AbortSignal', async t => {
	const controller = new AbortController();

	controller.abort(abortError);

	await t.throwsAsync(makeAsynchronous(() => {
		while (true) {
			// Wait to be aborted.
		}
	}).withSignal(controller.signal), {
		message: abortError.message,
	});
});

test('with interrupting abortion of AbortSignal', async t => {
	const controller = new AbortController();

	const promise = makeAsynchronous(() => {
		while (true) {
			// Wait to be aborted.
		}
	}).withSignal(controller.signal)();

	controller.abort(abortError);

	await t.throwsAsync(promise, {
		message: abortError.message,
	});
});

test('error', async t => {
	await t.throwsAsync(
		makeAsynchronous(() => {
			throw new TypeError('unicorn');
		})(),
		{
			instanceOf: TypeError,
			message: 'unicorn',
		},
	);
});

test('dynamic import works', async t => {
	await t.notThrowsAsync(makeAsynchronous(async () => {
		await import('time-span');
	})());
});

test('dynamic import of cwd dependencies works by default', async t => {
	const cwd = await fs.mkdtemp(`${tmpdir()}/make-asynchronous-`);

	try {
		const dependencyDirectory = new URL('node_modules/fixture-dependency/', pathToFileURL(`${cwd}/`));
		await fs.mkdir(dependencyDirectory, {recursive: true});
		await fs.writeFile(new URL('package.json', dependencyDirectory), JSON.stringify({
			type: 'module',
			exports: './index.js',
		}));
		await fs.writeFile(new URL('index.js', dependencyDirectory), 'export default "fixture";');

		const {stdout} = await execFileAsync(process.execPath, [
			'--input-type=module',
			'--eval',
			`
				import makeAsynchronous from ${JSON.stringify(new URL('index.js', import.meta.url).href)};

				const result = await makeAsynchronous(async () => {
					const {default: value} = await import('fixture-dependency');
					return value;
				})();

				console.log(result);
			`,
		], {
			cwd,
		});

		t.is(stdout.trim(), 'fixture');
	} finally {
		await fs.rm(cwd, {recursive: true});
	}
});

test('dynamic import of caller dependencies works with baseUrl', async t => {
	const fixture = await fs.mkdtemp(`${tmpdir()}/make-asynchronous-`);
	const cwd = await fs.mkdtemp(`${tmpdir()}/make-asynchronous-`);

	try {
		const dependencyDirectory = new URL('node_modules/fixture-dependency/', pathToFileURL(`${fixture}/`));
		await fs.mkdir(dependencyDirectory, {recursive: true});
		await fs.writeFile(new URL('package.json', dependencyDirectory), JSON.stringify({
			type: 'module',
			exports: './index.js',
		}));
		await fs.writeFile(new URL('index.js', dependencyDirectory), 'export default "fixture";');

		const script = new URL('run.mjs', pathToFileURL(`${fixture}/`));
		await fs.writeFile(script, `
			import makeAsynchronous from ${JSON.stringify(new URL('index.js', import.meta.url).href)};

			const result = await makeAsynchronous(async () => {
				const {default: value} = await import('fixture-dependency');
				return value;
			}, {
				baseUrl: import.meta.url,
			})();

			console.log(result);
		`);

		const {stdout} = await execFileAsync(process.execPath, [fileURLToPath(script)], {
			cwd,
		});

		t.is(stdout.trim(), 'fixture');
	} finally {
		await fs.rm(fixture, {recursive: true});
		await fs.rm(cwd, {recursive: true});
	}
});

test('import.meta works', async t => {
	const result = await makeAsynchronous(() => import.meta.url)();

	t.is(typeof result, 'string');
});

test('self works in Node.js workers', async t => {
	const result = await makeAsynchronous(() => self.crypto.randomUUID())(); // eslint-disable-line unicorn/prefer-global-this, no-undef

	t.is(typeof result, 'string');
});

test('iterator object', async t => {
	const fixture = [1, 2];

	const asyncIterable = makeAsynchronousIterable(fixture => fixture[Symbol.iterator]())(fixture);
	const result = [];

	for await (const value of asyncIterable) {
		result.push(value);
	}

	t.deepEqual(result, fixture);
});

test('iterator object with pre-aborted AbortSignal', async t => {
	const controller = new AbortController();

	controller.abort(abortError);

	const asyncIterable = makeAsynchronousIterable(function * () { // eslint-disable-line require-yield
		while (true) {
			// Wait to be aborted.
		}
	}).withSignal(controller.signal)();

	await t.throwsAsync(async () => {
		for await (const _ of asyncIterable) {
			// Iterate until aborted.
		}
	}, {
		message: abortError.message,
	});
});

test('iterator object with interrupting abortion of AbortSignal', async t => {
	const controller = new AbortController();

	const asyncIterable = makeAsynchronousIterable(function * () { // eslint-disable-line require-yield
		while (true) {
			// Wait to be aborted.
		}
	}).withSignal(controller.signal)();

	controller.abort(abortError);

	await t.throwsAsync(async () => {
		for await (const _ of asyncIterable) {
			// Iterate until aborted.
		}
	}, {
		message: abortError.message,
	});
});

test('generator function', async t => {
	const fixture = [1, 2];

	const asyncIterable = makeAsynchronousIterable(function * (fixture) {
		for (const value of fixture) {
			yield value;
		}
	})(fixture);

	const result = [];

	for await (const value of asyncIterable) {
		result.push(value);
	}

	t.deepEqual(result, fixture);
});

test('generator function that throws', async t => {
	const fixture = [1, 2];
	const errorMessage = 'Catch me if you can!';

	const asyncIterable = makeAsynchronousIterable(function * (fixture, errorMessage) {
		for (const value of fixture) {
			yield value;
		}

		throw new Error(errorMessage);
	})(fixture, errorMessage);

	const result = [];

	await t.throwsAsync(async () => {
		for await (const value of asyncIterable) {
			result.push(value);
		}
	}, {
		message: errorMessage,
	}, 'error is propagated');

	t.deepEqual(result, fixture);
});
