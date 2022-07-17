import {expectType} from 'tsd';
import makeAsynchronous, {makeAsynchronousIterable} from './index.js';

const {signal} = new AbortController();

const fn = makeAsynchronous((number: number) => number * 2); // eslint-disable-line @typescript-eslint/no-unsafe-assignment

expectType<Promise<number>>(fn(2));
expectType<Promise<number>>(fn.withSignal(signal)(2));

const fn2 = makeAsynchronousIterable(function * () { // eslint-disable-line @typescript-eslint/no-unsafe-assignment
	for (let number = 1; ; number++) {
		yield number;
	}
});

expectType<AsyncIterable<number>>(fn2());
expectType<AsyncIterable<number>>(fn2.withSignal(signal)());
