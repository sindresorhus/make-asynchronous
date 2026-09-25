import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {getEventListeners} from 'node:events';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';
import test from 'ava';
import delay from 'delay';
import makeAsynchronous, {makeAsynchronousIterable} from './index.js';

const abortError = new Error('Aborted');
const execFileAsync = promisify(execFile);
const source = await fs.readFile(new URL('index.js', import.meta.url), 'utf8');
const package_ = JSON.parse(await fs.readFile(new URL('package.json', import.meta.url), 'utf8'));

// A promise that never settles would otherwise hang the test run.
const settleWithin = async (promise, milliseconds = 10_000) => {
	let timeoutId;

	try {
		return await Promise.race([
			promise,
			new Promise((resolve, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error(`The promise did not settle within ${milliseconds}ms`));
				}, milliseconds);
			}),
		]);
	} finally {
		clearTimeout(timeoutId);
	}
};

// `t.throwsAsync()` only accepts `Error` instances, but a wrapped function can throw anything.
const getRejection = async promise => promise.then(() => {
	throw new Error('Expected the promise to reject, but it resolved');
}, error => error);

// A worker that fails at an unexpected moment takes down the whole process, so that has to be observed from the outside.
const runInChildProcess = async script => execFileAsync(process.execPath, [
	'--input-type=module',
	'--eval',
	script,
]);

test('browser entrypoint does not statically import worker_threads', t => {
	t.notRegex(source, /^import .*node:worker_threads/mv);
	t.notRegex(source, /import\(['"]node:worker_threads['"]\)/v);
});

test('Node engine supports syntax detection and module hooks', t => {
	t.is(package_.engines.node, '>=22.15.0');
});

test('runs the function in a worker without blocking the main thread', async t => {
	const fixture = {x: '🦄'};

	// Runs the given function while counting how often the main thread gets an event loop turn, which a blocked main thread cannot do at all.
	const whileRunning = async function_ => {
		let turns = 0;
		let isRunning = true;
		const countTurn = () => {
			if (isRunning) {
				turns += 1;
				setImmediate(countTurn);
			}
		};

		setImmediate(countTurn);

		try {
			const value = await function_();

			return {turns, value};
		} finally {
			isRunning = false;
		}
	};

	// The baseline: a main thread blocked this long cannot take a single event loop turn.
	const blocked = await whileRunning(async () => {
		const end = Date.now() + 300;

		while (Date.now() < end) {
			// Block the main thread.
		}
	});

	// The baseline is measured on this machine, so a loaded one cannot make the comparison unfair. The loop is spelled out again because the wrapped function is serialized.
	const {turns, value} = await whileRunning(async () => makeAsynchronous(fixture_ => {
		const end = Date.now() + 300;

		while (Date.now() < end) {
			// Block the worker.
		}

		return fixture_;
	})(fixture));

	t.deepEqual(value, fixture);
	t.true(turns > blocked.turns, `The main thread took ${blocked.turns} turns while blocked but only ${turns} while the worker ran`);
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

test('throws a value that is not an error', async t => {
	for (const value of ['unicorn', true, {message: 'unicorn'}]) {
		// eslint-disable-next-line no-await-in-loop
		t.deepEqual(await getRejection(settleWithin(makeAsynchronous(value_ => {
			throw value_;
		})(value))), value);
	}
});

test('throws a falsy value', async t => {
	// A falsy value must be reported as a rejection instead of being mistaken for a result.
	for (const value of [undefined, null, false, 0, '', Number.NaN]) {
		// eslint-disable-next-line no-await-in-loop
		t.is(await getRejection(settleWithin(makeAsynchronous(value_ => {
			throw value_;
		})(value))), value);
	}
});

test('returns a falsy value', async t => {
	// The mirror of throwing one, so a result can never be mistaken for a failure either.
	for (const value of [undefined, null, false, 0, '', Number.NaN]) {
		// eslint-disable-next-line no-await-in-loop
		t.is(await settleWithin(makeAsynchronous(value_ => value_)(value)), value);
	}
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

test('iterator object with abortion after some values', async t => {
	const controller = new AbortController();
	const result = [];

	await t.throwsAsync(async () => {
		for await (const value of makeAsynchronousIterable(function * () {
			yield 1;
			yield 2;
			yield 3;
		}).withSignal(controller.signal)()) {
			result.push(value);
			controller.abort(abortError);
		}
	}, {
		message: abortError.message,
	});

	// The values that made it through before the abortion are still the consumer's.
	t.deepEqual(result, [1]);
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

test('worker that fails between iterations does not crash the process', async t => {
	// The worker fails while the consumer is busy, so nothing is listening for the failure.
	const {stdout} = await runInChildProcess(`
		import {makeAsynchronousIterable} from ${JSON.stringify(new URL('index.js', import.meta.url).href)};

		// Shared memory lets the worker fail at the exact moment the consumer stops listening.
		const flag = new Int32Array(new SharedArrayBuffer(4));

		try {
			for await (const value of makeAsynchronousIterable(function * (flag_) {
				const intervalId = setInterval(() => {
					if (Atomics.load(flag_, 0) === 1) {
						clearInterval(intervalId);
						throw new Error('Worker failed');
					}
				}, 5);

				yield 1;
				yield 2;
			})(flag)) {
				console.log('value', value);

				Atomics.store(flag, 0, 1);

				await new Promise(resolve => {
					setTimeout(resolve, 100);
				});
			}

			console.log('completed');
		} catch (error) {
			console.log('caught', error.message);
		}
	`);

	t.is(stdout.trim(), 'value 1\ncaught Worker failed');
});

test('worker that exits without reporting an error', async t => {
	// A worker can stop without reporting an error, for example by calling `process.exit()`. A clean exit still means the reply is never coming.
	for (const code of [0, 1]) {
		// eslint-disable-next-line no-await-in-loop
		const error = await t.throwsAsync(settleWithin(makeAsynchronous(code_ => {
			process.exit(code_); // eslint-disable-line unicorn/no-process-exit
		})(code), 5000));

		t.is(error.message, `Worker exited with code ${code}`);
	}
});

test('iterable that is not an iterator', async t => {
	const fixtures = [[1, 2, 3], 'abc', new Set([1, 2, 3])];

	const results = await Promise.all(fixtures.map(async fixture => {
		const result = [];

		for await (const value of makeAsynchronousIterable(value_ => value_)(fixture)) {
			result.push(value);
		}

		return result;
	}));

	t.deepEqual(results, [
		[1, 2, 3],
		['a', 'b', 'c'],
		[1, 2, 3],
	]);
});

test('async iterable that is not an iterator', async t => {
	const result = [];

	for await (const value of makeAsynchronousIterable(() => ({
		async * [Symbol.asyncIterator]() {
			yield 1;
			yield 2;
		},
	}))()) {
		result.push(value);
	}

	t.deepEqual(result, [1, 2]);
});

test('iterable function that does not return an iterable', async t => {
	await t.throwsAsync(settleWithin((async () => {
		for await (const _ of makeAsynchronousIterable(() => undefined)()) {
			// Never reached.
		}
	})()), {instanceOf: TypeError});
});

test('iterable function that throws before returning', async t => {
	await t.throwsAsync(settleWithin((async () => {
		for await (const _ of makeAsynchronousIterable(() => {
			throw new TypeError('unicorn');
		})()) {
			// Never reached.
		}
	})()), {
		instanceOf: TypeError,
		message: 'unicorn',
	});
});

test('iterator that does not return an object', async t => {
	// The iterator protocol requires an object, so this must not loop forever.
	const error = await t.throwsAsync(settleWithin((async () => {
		for await (const _ of makeAsynchronousIterable(() => ({next: () => 5}))()) {
			// Never reached.
		}
	})(), 5000));

	t.is(error.message, 'Iterator result is not an object');
});

test('error properties are preserved', async t => {
	// Cloning an error drops its own properties, which is where things like `code` live.
	const error = await t.throwsAsync(makeAsynchronous(() => {
		const error = new Error('unicorn');
		error.code = 'ENOENT';
		error.detail = {value: 1};
		throw error;
	})());

	t.is(error.code, 'ENOENT');
	t.deepEqual(error.detail, {value: 1});
});

test('aggregate error is preserved', async t => {
	// Cloning turns an `AggregateError` into a plain `Error` and drops the errors it holds.
	const error = await t.throwsAsync(makeAsynchronous(() => {
		throw new AggregateError([new TypeError('first'), new TypeError('second')], 'Both failed');
	})());

	t.is(error.name, 'AggregateError');
	t.is(error.message, 'Both failed');
	t.is(error.errors.length, 2);
	t.is(error.errors[0].message, 'first');
	t.is(error.errors[1].message, 'second');
});

test('error name is preserved', async t => {
	const error = await t.throwsAsync(makeAsynchronous(() => {
		class UnicornError extends TypeError {
			get name() {
				return 'UnicornError';
			}
		}

		throw new UnicornError('unicorn');
	})());

	t.is(error.name, 'UnicornError');
	t.is(error.message, 'unicorn');
});

test('built-in error does not gain an own name property', async t => {
	const error = await t.throwsAsync(makeAsynchronous(() => {
		throw new TypeError('unicorn');
	})());

	// Cloning already carries the name over, so adding it as an own property would change how the error looks.
	t.false(Object.hasOwn(error, 'name'));
	t.deepEqual({...error}, {});
});

test('error cause is preserved', async t => {
	const error = await t.throwsAsync(makeAsynchronous(() => {
		throw new Error('unicorn', {cause: new TypeError('rainbow')});
	})());

	t.is(error.message, 'unicorn');
	t.true(error.cause instanceof TypeError);
	t.is(error.cause.message, 'rainbow');
});

test('error with a property that cannot be cloned', async t => {
	// A function property cannot be cloned, so the error has to come back without its properties rather than not come back at all. Its name is a string, so that still comes along.
	const error = await t.throwsAsync(settleWithin(makeAsynchronous(() => {
		class UnicornError extends Error {
			name = 'UnicornError';
		}

		const error = new UnicornError('unicorn');

		error.handler = () => {
			// A function cannot be cloned.
		};

		throw error;
	})()));

	t.true(error instanceof Error);
	t.is(error.name, 'UnicornError');
	t.is(error.message, 'unicorn');
});

test('argument that cannot be cloned', async t => {
	// A function can never be sent to a worker, so the call can only end in a rejection.
	const cannotBeCloned = () => {
		// A function cannot be cloned.
	};

	const promises = [
		makeAsynchronous(value => value)(cannotBeCloned),
		(async () => {
			for await (const _ of makeAsynchronousIterable(value => [value])(cannotBeCloned)) {
				// Never reached.
			}
		})(),
	];

	for (const promise of promises) {
		// eslint-disable-next-line no-await-in-loop
		const error = await t.throwsAsync(settleWithin(promise));

		t.regex(error.message, /could not be cloned/v);

		// A late worker error would take down the whole process, so give it a moment to surface.
		// eslint-disable-next-line no-await-in-loop
		await delay(100);
	}
});

test('return value that cannot be cloned', async t => {
	// The worker cannot post the value, so the clone error has to survive the trip back.
	const error = await t.throwsAsync(makeAsynchronous(() => () => {
		// A function cannot be cloned.
	})());

	t.is(error.name, 'DataCloneError');
	t.regex(error.message, /could not be cloned/v);
});

test('baseUrl accepts a URL', async t => {
	t.is(await makeAsynchronous(async () => {
		const {default: timeSpan} = await import('time-span');
		return typeof timeSpan;
	}, {
		baseUrl: new URL('index.js', import.meta.url),
	})(), 'function');
});

test('iterable with a signal that is never aborted', async t => {
	const fixture = [1, 2, 3];

	const result = [];

	for await (const value of makeAsynchronousIterable(value_ => value_).withSignal(new AbortController().signal)(fixture)) {
		result.push(value);
	}

	t.deepEqual(result, fixture);
});

test('empty iterable', async t => {
	const result = [];

	for await (const value of makeAsynchronousIterable(function * () {
		// Nothing to yield.
	})()) {
		result.push(value);
	}

	t.deepEqual(result, []);
});

test('iterable yields falsy values', async t => {
	const fixture = [undefined, null, false, 0, '', Number.NaN];

	const result = [];

	for await (const value of makeAsynchronousIterable(function * (fixture_) {
		yield * fixture_;
	})(fixture)) {
		result.push(value);
	}

	t.deepEqual(result, fixture);
});

test('iterable error properties are preserved', async t => {
	const error = await t.throwsAsync((async () => {
		for await (const _ of makeAsynchronousIterable(function * () { // eslint-disable-line require-yield
			const error = new Error('unicorn');
			error.code = 'E_ITERABLE';
			throw error;
		})()) {
			// Never reached.
		}
	})());

	t.is(error.code, 'E_ITERABLE');
});

test('worker that exits during iteration', async t => {
	const error = await t.throwsAsync((async () => {
		for await (const _ of makeAsynchronousIterable(function * () {
			yield 1;
			process.exit(1); // eslint-disable-line unicorn/no-process-exit
		})()) {
			// Never reached.
		}
	})());

	t.is(error.message, 'Worker exited with code 1');
});

test('concurrent calls', async t => {
	const fn = makeAsynchronous(value => value * 2);

	t.deepEqual(await Promise.all(Array.from({length: 10}, async (_, index) => fn(index))), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
});

test('concurrent iterations', async t => {
	const fn = makeAsynchronousIterable(function * (count) {
		for (let index = 0; index < count; index += 1) {
			yield index;
		}
	});

	// Each iteration gets its own worker, so the iterator state cannot leak between them.
	const collect = async count => {
		const values = [];

		for await (const value of fn(count)) {
			values.push(value);
		}

		return values;
	};

	t.deepEqual(await Promise.all([collect(2), collect(3)]), [[0, 1], [0, 1, 2]]);
});

test('rich return value', async t => {
	const fixture = {
		date: new Date('2020-01-01T00:00:00.000Z'),
		map: new Map([['key', 'value']]),
		set: new Set([1, 2]),
		regexp: /unicorn/gv,
		nested: {array: [1, [2, [3]]]},
		null_: null,
		bigint_: 10n,
	};

	t.deepEqual(await makeAsynchronous(value => value)(fixture), fixture);
});

test('many arguments', async t => {
	const fixture = Array.from({length: 100}, (_, index) => index);

	t.is(await makeAsynchronous((...arguments_) => arguments_.length)(...fixture), 100);
});

test('messages posted by the wrapped function are ignored', async t => {
	// The wrapped function shares the worker globals, so a message of its own must not be mistaken for the reply.
	t.is(await makeAsynchronous(value => {
		globalThis.postMessage('progress');
		globalThis.postMessage({output: 'injected'});
		globalThis.postMessage({error: new Error('injected')});
		return value;
	})('result'), 'result');
});

test('iterable cannot be taken over by the wrapped function', async t => {
	const result = [];

	for await (const value of makeAsynchronousIterable(function * () {
		globalThis.postMessage({value: 'injected', done: false});
		yield 1;
		yield 2;
	})()) {
		result.push(value);
	}

	t.deepEqual(result, [1, 2]);
});

test('worker that exits after replying', async t => {
	// A reply that the worker posted before exiting must still be delivered, so the exit cannot be allowed to win over it.
	const fn = makeAsynchronous(() => {
		setImmediate(() => {
			process.exit(0); // eslint-disable-line unicorn/no-process-exit
		});

		return 'result';
	});

	const results = await Promise.all(Array.from({length: 30}, async () => fn()));

	t.deepEqual([...new Set(results)], ['result']);
});

test('worker that fails with a falsy value', async t => {
	// A worker can fail with any value, so a falsy one must still stop the requests that come after it instead of leaving them waiting for a worker that is gone.
	const reason = await getRejection(settleWithin((async () => {
		for await (const _ of makeAsynchronousIterable(function * () {
			setTimeout(() => {
				throw 0; // eslint-disable-line no-throw-literal
			});

			yield 1;
			yield 2;
		})()) {
			await delay(100);
		}
	})(), 5000));

	t.is(reason, 0);
});

test('worker that fails while the function is still running', async t => {
	// Nothing in the function catches an error thrown from a timer, so it reaches the worker instead of the reply.
	const error = await getRejection(settleWithin(makeAsynchronous(() => {
		setTimeout(() => {
			throw new Error('Worker failed');
		});

		return new Promise(() => {
			// Never settles.
		});
	})(), 5000));

	t.is(error.message, 'Worker failed');
});

test('thrown value that cannot be cloned', async t => {
	// Neither the value nor anything about it can be sent back, so the clone error takes its place.
	const error = await t.throwsAsync(settleWithin(makeAsynchronous(() => {
		// eslint-disable-next-line no-throw-literal
		throw () => {
			// A function cannot be cloned.
		};
	})()));

	t.is(error.name, 'DataCloneError');
	t.regex(error.message, /could not be cloned/v);
});

test('rejects with the exact abort reason', async t => {
	// The reason is passed through as is, also when it is falsy and could be mistaken for no failure.
	for (const reason of [new TypeError('unicorn'), 0]) {
		const controller = new AbortController();
		const fn = makeAsynchronous(() => {
			while (true) {
				// Wait to be aborted.
			}
		}).withSignal(controller.signal);

		const iterable = makeAsynchronousIterable(function * () {
			yield 1;

			while (true) {
				// Wait to be aborted.
			}
		}).withSignal(controller.signal);

		const promises = [
			fn(),
			(async () => {
				for await (const _ of iterable()) {
					// Abort once the worker is busy with the next value.
					setTimeout(() => {
						controller.abort(reason);
					}, 100);
				}
			})(),
		];

		for (const promise of promises) {
			// eslint-disable-next-line no-await-in-loop
			t.is(await getRejection(settleWithin(promise)), reason);
		}
	}
});

test('rejects with the exact reason of a pre-aborted signal', async t => {
	for (const reason of [new TypeError('unicorn'), 0]) {
		const controller = new AbortController();
		controller.abort(reason);

		const promises = [
			makeAsynchronous(value => value).withSignal(controller.signal)(1),
			(async () => {
				for await (const _ of makeAsynchronousIterable(value => [value]).withSignal(controller.signal)(1)) {
					// Never reached.
				}
			})(),
		];

		for (const promise of promises) {
			// eslint-disable-next-line no-await-in-loop
			t.is(await getRejection(settleWithin(promise)), reason);
		}
	}
});

test('abort listener is removed once done', async t => {
	// A long-lived signal is reused across many calls, so each call must stop listening to it when it is done.
	const {signal} = new AbortController();

	await makeAsynchronous(value => value).withSignal(signal)(1);

	// Stopping part way through must also let go of the signal.
	const iterator = makeAsynchronousIterable(function * () {
		yield 1;
		yield 2;
	}).withSignal(signal)()[Symbol.asyncIterator]();
	await iterator.next();
	await iterator.return();

	t.is(getEventListeners(signal, 'abort').length, 0);
});
