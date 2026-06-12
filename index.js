import {pEvent} from 'p-event';

const isNode = Boolean(globalThis.process?.versions?.node);

// Assembled at runtime so bundlers don't statically detect the import and try to bundle `node:worker_threads` for browsers.
const workerThreadsSpecifier = ['node:', 'worker_threads'].join('');

const makeBlob = content => new globalThis.Blob([content], {type: 'text/javascript'});

// A worker_threads message arrives as the raw value, while a Web Worker wraps it in a `MessageEvent`.
const getMessageData = message => isNode ? message : message.data;

/*
On Node.js, the worker source is executed directly via `eval`, and this preamble shims the Web Worker globals (`postMessage`/`onmessage`) that the worker body uses onto `worker_threads`'s `parentPort`. This lets the exact same worker body run in both Node.js and browsers.
*/
const nodeWorkerPreamble = String.raw`
	import {parentPort, workerData} from 'node:worker_threads';
	import {registerHooks} from 'node:module';
	const isBareSpecifier = specifier => !specifier.startsWith('.') && !specifier.startsWith('/') && !/^[a-z\d+.-]+:/i.test(specifier);
	if (workerData.baseUrl) {
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (context.parentURL === import.meta.url && isBareSpecifier(specifier)) {
					return nextResolve(specifier, {...context, parentURL: workerData.baseUrl});
				}

				return nextResolve(specifier, context);
			},
		});
	}
	globalThis.self = globalThis;
	globalThis.postMessage = data => parentPort.postMessage(data);
	parentPort.on('message', data => globalThis.onmessage({data}));
`;

async function createWorker(content, {baseUrl} = {}) {
	let url;
	let worker;

	const cleanup = () => {
		if (url) {
			URL.revokeObjectURL(url);
		}

		worker?.terminate();
	};

	if (isNode) {
		const {Worker: NodeWorker} = await import(workerThreadsSpecifier);
		worker = new NodeWorker(nodeWorkerPreamble + content, {
			eval: true,
			workerData: {
				baseUrl: baseUrl ? String(baseUrl) : undefined,
			},
		});
	} else {
		url = URL.createObjectURL(makeBlob(content));
		worker = new globalThis.Worker(url, {type: 'module'});
	}

	return {
		worker,
		cleanup,
	};
}

const makeContent = function_ =>
	`
	globalThis.onmessage = async ({data: arguments_}) => {
		try {
			const output = await (${function_.toString()})(...arguments_);
			globalThis.postMessage({output});
		} catch (error) {
			globalThis.postMessage({error});
		}
	};
	`;

export default function makeAsynchronous(function_, options) {
	const content = makeContent(function_);
	const setup = () => createWorker(content, options);

	async function run({worker, arguments_}) {
		const promise = pEvent(worker, 'message', {
			rejectionEvents: ['error', 'messageerror'],
		});

		worker.postMessage(arguments_);

		const {output, error} = getMessageData(await promise);

		if (error) {
			throw error;
		}

		return output;
	}

	const fn = async (...arguments_) => {
		const {worker, cleanup} = await setup();

		try {
			return await run({arguments_, worker});
		} finally {
			cleanup();
		}
	};

	fn.withSignal = signal => async (...arguments_) => {
		signal.throwIfAborted();

		let cleanup;

		try {
			const {worker, cleanup: cleanup_} = await setup();
			cleanup = cleanup_;
			signal.throwIfAborted();

			const abortPromise = pEvent(signal, [], {
				rejectionEvents: ['abort'],
			});

			try {
				return await Promise.race([
					run({arguments_, worker}),
					abortPromise,
				]);
			} finally {
				abortPromise.cancel();
			}
		} catch (error) {
			signal.throwIfAborted();
			throw error;
		} finally {
			cleanup?.();
		}
	};

	return fn;
}

const makeIterableContent = function_ =>
	`
	const nothing = Symbol('nothing');
	let iterator = nothing;

	globalThis.onmessage = async ({data: arguments_}) => {
		try {
			if (iterator === nothing) {
				iterator = await (${function_.toString()})(...arguments_);
			}

			const output = await iterator.next();
			globalThis.postMessage({output});
		} catch (error) {
			globalThis.postMessage({error});
		}
	};
	`;

export function makeAsynchronousIterable(function_, options) {
	const content = makeIterableContent(function_);
	const setup = () => createWorker(content, options);

	const fn = (...arguments_) => ({
		async * [Symbol.asyncIterator]() {
			const {worker, cleanup} = await setup();

			try {
				let isFirstMessage = true;

				while (true) {
					const promise = pEvent(worker, 'message', {
						rejectionEvents: ['error', 'messageerror'],
					});

					worker.postMessage(isFirstMessage ? arguments_ : undefined);
					isFirstMessage = false;

					const {output, error} = getMessageData(await promise); // eslint-disable-line no-await-in-loop

					if (error) {
						throw error;
					}

					const {value, done} = output;

					if (done) {
						break;
					}

					yield value;
				}
			} finally {
				cleanup();
			}
		},
	});

	fn.withSignal = signal => (...arguments_) => ({
		async * [Symbol.asyncIterator]() {
			signal.throwIfAborted();

			let cleanup;

			try {
				const {worker, cleanup: cleanup_} = await setup();
				cleanup = cleanup_;
				signal.throwIfAborted();

				const abortPromise = pEvent(signal, [], {
					rejectionEvents: ['abort'],
				});

				let isFirstMessage = true;

				try {
					while (true) {
						const promise = Promise.race([
							pEvent(worker, 'message', {
								rejectionEvents: ['error', 'messageerror'],
							}),
							abortPromise,
						]);

						worker.postMessage(isFirstMessage ? arguments_ : undefined);
						isFirstMessage = false;

						const {output, error} = getMessageData(await promise); // eslint-disable-line no-await-in-loop

						if (error) {
							throw error;
						}

						const {value, done} = output;

						if (done) {
							break;
						}

						yield value;
					}
				} finally {
					abortPromise.cancel();
				}
			} catch (error) {
				signal.throwIfAborted();
				throw error;
			} finally {
				cleanup?.();
			}
		},
	});

	return fn;
}
