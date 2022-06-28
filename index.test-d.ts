import {expectType} from 'tsd';
import makeAsynchronous, {makeAsynchronousIterable} from './index.js';

const fn = makeAsynchronous((number: number) => number * 2); // eslint-disable-line @typescript-eslint/no-unsafe-assignment

expectType<Promise<number>>(fn(2));

const fn2 = makeAsynchronousIterable(function * () { // eslint-disable-line @typescript-eslint/no-unsafe-assignment
	for (let number = 1; ; number++) {
		yield number;
	}
});

expectType<AsyncIterable<number>>(fn2());
