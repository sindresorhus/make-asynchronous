import {expectType} from 'tsd';
import makeAsynchronous from './index.js';

const fn = makeAsynchronous((number: number) => number * 2); // eslint-disable-line @typescript-eslint/no-unsafe-assignment

expectType<Promise<number>>(fn(2));
