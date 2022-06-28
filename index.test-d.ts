import {expectType} from 'tsd';
import makeAsynchronous, {makeAsynchronousIterator} from './index.js';

const fn = makeAsynchronous((number: number) => number * 2); // eslint-disable-line @typescript-eslint/no-unsafe-assignment

expectType<Promise<number>>(fn(2));

const fn2 = makeAsynchronousIterator(function * () { // eslint-disable-line @typescript-eslint/no-unsafe-assignment
	for (let number = 1; ; number++) {
		yield number;
	}
});

expectType<Promise<AsyncIterable<number>>>(fn2());
