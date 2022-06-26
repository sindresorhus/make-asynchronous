import Worker from 'web-worker';

const isNode = Boolean(globalThis.process?.versions?.node);

const makeContent = function_ =>
	`
	globalThis.onmessage = async event => {
		try {
			const output = await (${function_.toString()})(...event.data);
			globalThis.postMessage({output});
		} catch (error) {
			globalThis.postMessage({error});
		}
	};
	`;

const makeBlob = function_ => new globalThis.Blob([makeContent(function_)], {type: 'text/javascript'});

// TODO: Remove this when targeting Node.js 18 (`Blob` global is supported) and if https://github.com/developit/web-worker/issues/30 is fixed.
const makeDataUrl = function_ => {
	const data = globalThis.Buffer.from(makeContent(function_)).toString('base64');
	return `data:text/javascript;base64,${data}`;
};

export default function makeAsynchronous(function_) {
	return (...arguments_) => new Promise((resolve, reject) => {
		let url;
		let worker;

		const cleanup = () => {
			if (url) {
				URL.revokeObjectURL(url);
			}

			worker?.terminate();
		};

		const failure = error => {
			cleanup();
			reject(error);
		};

		try {
			if (isNode) {
				worker = new Worker(makeDataUrl(function_), {type: 'module'});
			} else {
				url = URL.createObjectURL(makeBlob(function_));
				worker = new Worker(url, {type: 'module'});
			}
		} catch (error) {
			failure(error);
			return;
		}

		worker.addEventListener('message', ({data}) => {
			if (data.error) {
				failure(data.error);
			} else {
				cleanup();
				resolve(data.output);
			}
		});

		worker.addEventListener('messageerror', error => {
			failure(error);
		});

		worker.addEventListener('error', error => {
			failure(error);
		});

		try {
			worker.postMessage(arguments_);
		} catch (error) {
			failure(error);
		}
	});
}
