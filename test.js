import test from 'ava';
import timeSpan from 'time-span';
import inRange from 'in-range';
import makeAsynchronous, {makeAsynchronousIterable} from './index.js';

const testIf = condition => condition ? test : () => {};

test('main', async t => {
	const fixture = {x: '🦄'};
	const end = timeSpan();

	const result = await makeAsynchronous(fixture => {
		let x = '1';

		while (true) { // eslint-disable-line no-constant-condition
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

testIf(globalThis.AbortController)('with pre-aborted AbortSignal', async t => {
	const controller = new AbortController();
	const abortMessage = 'Aborted';

	controller.abort(abortMessage);

	await t.throwsAsync(makeAsynchronous(() => {
		while (true) {} // eslint-disable-line no-constant-condition, no-empty
	}).withSignal(controller.signal), {
		message: abortMessage,
	});
});

testIf(globalThis.AbortController)('with interrupting abortion of AbortSignal', async t => {
	const controller = new AbortController();
	const abortMessage = 'Aborted';

	const promise = makeAsynchronous(() => {
		while (true) {} // eslint-disable-line no-constant-condition, no-empty
	}).withSignal(controller.signal)();

	controller.abort(abortMessage);

	await t.throwsAsync(promise, {
		message: abortMessage,
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

test.failing('dynamic import works', async t => {
	await t.notThrowsAsync(
		makeAsynchronous(async () => {
			await import('time-span');
		})(),
	);
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

testIf(globalThis.AbortController)('iterator object with pre-aborted AbortSignal', async t => {
	const controller = new AbortController();
	const abortMessage = 'Aborted';

	controller.abort(abortMessage);

	const asyncIterable = makeAsynchronousIterable(function * () { // eslint-disable-line require-yield
		while (true) {} // eslint-disable-line no-constant-condition, no-empty
	}).withSignal(controller.signal)();

	await t.throwsAsync(async () => {
		for await (const _ of asyncIterable) {} // eslint-disable-line no-unused-vars, no-empty
	}, {
		message: abortMessage,
	});
});

testIf(globalThis.AbortController)('iterator object with interrupting abortion of AbortSignal', async t => {
	const controller = new AbortController();
	const abortMessage = 'Aborted';

	const asyncIterable = makeAsynchronousIterable(function * () { // eslint-disable-line require-yield
		while (true) {} // eslint-disable-line no-constant-condition, no-empty
	}).withSignal(controller.signal)();

	controller.abort(abortMessage);

	await t.throwsAsync(async () => {
		for await (const _ of asyncIterable) {} // eslint-disable-line no-unused-vars, no-empty
	}, {
		message: abortMessage,
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
