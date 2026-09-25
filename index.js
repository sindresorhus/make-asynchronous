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

async function createWorker(content, {baseUrl} = {}, signal) {
	const {Worker} = isNode ? await import(workerThreadsSpecifier) : globalThis;

	// Checked after the only `await`, so an abortion at any point before the worker exists means it is never created.
	signal?.throwIfAborted();

	let url;
	let worker;

	// A worker can fail at any moment, also when the main thread is not waiting for a message. Remember the failure so it can still be surfaced, and keep a permanent listener so that a late failure never becomes an uncaught exception. A worker can fail with any value, including a falsy one, so the value cannot tell whether it did.
	let hasFailed = false;
	let failure;

	// A worker only ever has one request in flight, as a call makes one and an iteration waits for each reply before it asks for the next value. One listener serves every request, so iterating does not pay for a listener per item.
	let pendingRequest;

	const rememberFailure = error => {
		if (hasFailed) {
			return;
		}

		hasFailed = true;
		failure = error;

		pendingRequest?.reject(error);
		pendingRequest = undefined;
	};

	// An abortion is just another way for the worker to fail.
	const abort = () => {
		rememberFailure(signal.reason);
	};

	const cleanup = () => {
		signal?.removeEventListener('abort', abort);

		if (url) {
			URL.revokeObjectURL(url);
		}

		worker?.terminate();
	};

	if (isNode) {
		worker = new Worker(nodeWorkerPreamble + content, {
			eval: true,
			workerData: {
				baseUrl: baseUrl ? String(baseUrl) : undefined,
			},
		});
	} else {
		url = URL.createObjectURL(makeBlob(content));

		try {
			worker = new Worker(url, {type: 'module'});
		} catch (error) {
			// `cleanup()` is never handed out when the worker cannot be created, for example because of a content security policy, so the URL has to be revoked here.
			URL.revokeObjectURL(url);
			throw error;
		}
	}

	signal?.addEventListener('abort', abort);

	// A Node.js worker is an `EventEmitter` while a Web Worker only has `addEventListener()`.
	const on = (event, listener) => {
		if (isNode) {
			worker.on(event, listener);
		} else {
			worker.addEventListener(event, listener);
		}
	};

	// A stray message that no request is waiting for is dropped, which keeps the wrapped function from taking over the message channel.
	on('message', message => {
		const data = getMessageData(message);

		if (pendingRequest && data?.id === pendingRequest.id) {
			pendingRequest.resolve(data);
			pendingRequest = undefined;
		}
	});

	on('error', rememberFailure);
	on('messageerror', rememberFailure);

	if (isNode) {
		// A worker can also stop without reporting an error, for example by calling `process.exit()`. Node.js delivers the messages the worker posted before emitting `exit`, so a reply sent just before stopping still arrives.
		on('exit', code => {
			rememberFailure(new Error(`Worker exited with code ${code}`));
		});
	}

	let requestCount = 0;

	// Posts to the worker and waits for the reply, rejecting if the worker fails first.
	const request = arguments_ => {
		if (hasFailed) {
			return Promise.reject(failure);
		}

		// The wrapped function shares the worker globals and can post messages of its own, so every reply carries the id of the request it answers.
		const id = ++requestCount;

		const promise = new Promise((resolve, reject) => {
			pendingRequest = {id, resolve, reject};
		});

		try {
			worker.postMessage({id, arguments_});
		} catch (error) {
			// Posting throws for arguments that cannot be cloned, which would leave the wait dangling.
			pendingRequest = undefined;
			throw error;
		}

		return promise;
	};

	return {
		cleanup,
		request,
	};
}

// Cloning an error keeps only its message, stack, and cause, so everything else is sent along. A property that cannot be cloned would take the whole message down with it, hence the fallback, and a thrown value that cannot be cloned at all is replaced by the error that says so.
const errorReporter = String.raw`
	const getErrorProperties = error => {
		if (typeof error !== 'object' || error === null) {
			return undefined;
		}

		const properties = {...error};

		// Not an own enumerable property, so spreading the error would miss it.
		if (Array.isArray(error.errors)) {
			properties.errors = error.errors;
		}

		return properties;
	};

	const reportError = (error, id) => {
		let errorName;

		try {
			// A name lives outside the own enumerable properties, and cloning drops a custom one, so it travels on its own.
			errorName = typeof error?.name === 'string' ? error.name : undefined;

			globalThis.postMessage({id, error, errorName, errorProperties: getErrorProperties(error)});
		} catch {
			try {
				// The name is a string, so it can always come along.
				globalThis.postMessage({id, error, errorName});
			} catch (cloneError) {
				globalThis.postMessage({id, error: cloneError});
			}
		}
	};
`;

const makeContent = function_ =>
	errorReporter
	+ `
	globalThis.onmessage = async ({data: {id, arguments_}}) => {
		try {
			const output = await (${function_.toString()})(...arguments_);
			globalThis.postMessage({id, output});
		} catch (error) {
			reportError(error, id);
		}
	};
	`;

// The worker reports a result as `{output}` and a failure as `{error}`, so the key tells them apart. A function can throw anything, including `undefined`, so the value itself cannot be used for that.
const getResult = data => {
	if ('error' in data) {
		// Cloning keeps the name of a built-in error and drops a custom one. Defining is needed because an error can have a getter-only name, like `DOMException.name`.
		if (data.errorName !== undefined && data.error.name !== data.errorName) {
			Object.defineProperty(data.error, 'name', {value: data.errorName, writable: true, configurable: true});
		}

		if (data.errorProperties) {
			// Defining is needed because an error can have a getter-only property.
			Object.defineProperties(data.error, Object.getOwnPropertyDescriptors(data.errorProperties));
		}

		throw data.error;
	}

	return data.output;
};

export default function makeAsynchronous(function_, options) {
	const content = makeContent(function_);

	const run = async (arguments_, signal) => {
		const {cleanup, request} = await createWorker(content, options, signal);

		try {
			return getResult(await request(arguments_));
		} finally {
			cleanup();
		}
	};

	const fn = async (...arguments_) => run(arguments_);
	fn.withSignal = signal => async (...arguments_) => run(arguments_, signal);

	return fn;
}

const makeIterableContent = function_ =>
	errorReporter
	+ `
	const nothing = Symbol('nothing');
	let iterator = nothing;

	globalThis.onmessage = async ({data: {id, arguments_}}) => {
		try {
			if (iterator === nothing) {
				const iterable = await (${function_.toString()})(...arguments_);
				// A function can return any iterable, not just an iterator.
				iterator = iterable[Symbol.asyncIterator]?.() ?? iterable[Symbol.iterator]?.() ?? iterable;
			}

			const output = await iterator.next();

			// The iterator protocol requires an object, otherwise the iteration would never end.
			if (typeof output !== 'object' || output === null) {
				throw new TypeError('Iterator result is not an object');
			}

			globalThis.postMessage({id, output});
		} catch (error) {
			reportError(error, id);
		}
	};
	`;

export function makeAsynchronousIterable(function_, options) {
	const content = makeIterableContent(function_);

	const iterate = async function * (arguments_, signal) {
		const {cleanup, request} = await createWorker(content, options, signal);

		try {
			// The wrapped function only runs for the first message, so the later ones carry no arguments and skip re-cloning them for every item.
			let datum = arguments_;

			while (true) {
				const {value, done} = getResult(await request(datum)); // eslint-disable-line no-await-in-loop
				datum = undefined;

				if (done) {
					break;
				}

				yield value;
			}
		} finally {
			cleanup();
		}
	};

	const fn = (...arguments_) => ({
		[Symbol.asyncIterator]: () => iterate(arguments_),
	});

	fn.withSignal = signal => (...arguments_) => ({
		[Symbol.asyncIterator]: () => iterate(arguments_, signal),
	});

	return fn;
}
