import Worker from 'web-worker';
import {pEvent} from 'p-event';

const isNode = Boolean(globalThis.process?.versions?.node);

const makeBlob = content => new globalThis.Blob([content], {type: 'text/javascript'});

/**
An error to be thrown when the request is aborted by AbortController.
DOMException is thrown instead of this Error when DOMException is available.
*/
export class AbortError extends Error {
	constructor(message) {
		super();
		this.name = 'AbortError';
		this.message = message;
	}
}

/**
TODO: Remove AbortError and just throw DOMException when targeting Node 18.
*/
const getDOMException = errorMessage => globalThis.DOMException === undefined
	? new AbortError(errorMessage)
	: new DOMException(errorMessage);

/**
TODO: Remove below function and just 'reject(signal.reason)' when targeting Node 18.
*/
function getAbortedReason(signal) {
	const reason = signal.reason === undefined
		? getDOMException('This operation was aborted.')
		: signal.reason;

	return reason instanceof Error ? reason : getDOMException(reason);
}

// TODO: Remove this when targeting Node.js 18 (`Blob` global is supported) and if https://github.com/developit/web-worker/issues/30 is fixed.
const makeDataUrl = content => {
	const data = globalThis.Buffer.from(content).toString('base64');
	return `data:text/javascript;base64,${data}`;
};

function createWorker(content) {
	let url;
	let worker;

	const cleanup = () => {
		if (url) {
			URL.revokeObjectURL(url);
		}

		worker?.terminate();
	};

	if (isNode) {
		worker = new Worker(makeDataUrl(content), {type: 'module'});
	} else {
		url = URL.createObjectURL(makeBlob(content));
		worker = new Worker(url, {type: 'module'});
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

export default function makeAsynchronous(function_) {
	const content = makeContent(function_);
	const setup = () => createWorker(content);

	async function run({worker, arguments_}) {
		const promise = pEvent(worker, 'message', {
			rejectionEvents: ['error', 'messageerror'],
		});

		worker.postMessage(arguments_);

		const {data: {output, error}} = await promise;

		if (error) {
			throw error;
		}

		return output;
	}

	const fn = async (...arguments_) => {
		const {worker, cleanup} = setup();

		try {
			return await run({arguments_, worker});
		} finally {
			cleanup();
		}
	};

	fn.withSignal = signal => async (...arguments_) => {
		if (signal.aborted) {
			throw getAbortedReason(signal);
		}

		const {worker, cleanup} = setup();

		const abortPromise = pEvent(signal, [], {
			rejectionEvents: ['abort'],
		});

		try {
			return await Promise.race([
				run({arguments_, worker}),
				abortPromise,
			]);
		} catch (error) {
			if (signal.aborted) {
				throw getAbortedReason(signal);
			}

			throw error;
		} finally {
			abortPromise.cancel();
			cleanup();
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

export function makeAsynchronousIterable(function_) {
	const content = makeIterableContent(function_);
	const setup = () => createWorker(content);

	const fn = (...arguments_) => ({
		async * [Symbol.asyncIterator]() {
			const {worker, cleanup} = setup();

			try {
				let isFirstMessage = true;

				while (true) {
					const promise = pEvent(worker, 'message', {
						rejectionEvents: ['error', 'messageerror'],
					});

					worker.postMessage(isFirstMessage ? arguments_ : undefined);
					isFirstMessage = false;

					const {data: {output, error}} = await promise; // eslint-disable-line no-await-in-loop

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
			if (signal.aborted) {
				throw getAbortedReason(signal);
			}

			const {worker, cleanup} = setup();

			const abortPromise = pEvent(signal, [], {
				rejectionEvents: ['abort'],
			});

			try {
				let isFirstMessage = true;

				while (true) {
					const promise = Promise.race([
						pEvent(worker, 'message', {
							rejectionEvents: ['error', 'messageerror'],
						}),
						abortPromise,
					]);

					worker.postMessage(isFirstMessage ? arguments_ : undefined);
					isFirstMessage = false;

					const {data: {output, error}} = await promise; // eslint-disable-line no-await-in-loop

					if (error) {
						throw error;
					}

					const {value, done} = output;

					if (done) {
						break;
					}

					yield value;
				}
			} catch (error) {
				if (signal.aborted) {
					throw getAbortedReason(signal);
				}

				throw error;
			} finally {
				cleanup();
			}
		},
	});

	return fn;
}
