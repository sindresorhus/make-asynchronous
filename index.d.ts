import {Asyncify, SetReturnType} from 'type-fest';

type AnyFunction = (...arguments_: any) => unknown;

/**
Make a synchronous function asynchronous by running it in a worker.

Returns a wrapped version of the given function which executes asynchronously in a background thread (meaning it will not block the main thread).

The given function is serialized, so you cannot use any variables or imports from outside the function scope. You can instead pass in arguments to the function.

@example
```
import makeAsynchronous from 'make-asynchronous';

const fn = makeAsynchronous(number => {
	return performExpensiveOperation(number);
});

console.log(await fn(2));
//=> 345342
```
*/
export default function makeAsynchronous<T extends AnyFunction>(function_: T): Asyncify<T>;

type IteratorFunctionValue<T> = T extends (...arguments_: any) => AsyncIterable<infer Value> | Iterable<infer Value> ? Value : any;

/**
Make the iterator returned by a function asynchronous by running it in a worker.

Returns a wrapped version of the given function which executes asynchronously in a background thread (meaning it will not block the main thread).

The given function is serialized, so you cannot use any variables or imports from outside the function scope. You can instead pass in arguments to the function.

@example
```
import makeAsynchronous from 'make-asynchronous';

const fn = makeAsynchronous(function * () {
	yield * performExpensiveOperation(number);
});

for await (const number of await fn(2)) {
	console.log(number);
}
```
*/
export function makeAsynchronousIterator<T extends (...arguments_: any) => AsyncIterable<any> | Iterable<any>>(function_: T): SetReturnType<T, AsyncIterable<IteratorFunctionValue<T>>>;
