import Worker from 'web-worker';
import {pEvent} from 'p-event';

const isNode = Boolean(globalThis.process?.versions?.node);

const makeBlob = content => new globalThis.Blob([content], {type: 'text/javascript'});

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
	return async (...arguments_) => {
		const {worker, cleanup} = createWorker(makeContent(function_));

		try {
			const promise = pEvent(worker, 'message', {
				rejectionEvents: ['error', 'messageerror'],
			});

			worker.postMessage(arguments_);

			const {data: {output, error}} = await promise;

			if (error) {
				throw error;
			}

			return output;
		} finally {
			cleanup();
		}
	};
}

const makeIteratorContent = function_ =>
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

export function makeAsynchronousIterator(function_) {
	return (...arguments_) => ({
		async * [Symbol.asyncIterator]() {
			const {worker, cleanup} = createWorker(makeIteratorContent(function_));

			try {
				let isFirstMessage = true;

				while (true) {
					const promise = pEvent(worker, 'message', {
						rejectionEvents: ['messageerror', 'error'],
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
}
